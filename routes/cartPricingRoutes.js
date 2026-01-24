// routes/cartPricingRoutes.js (ESM) — PRODUCTION-GRADE
import express from "express";
import { ObjectId } from "mongodb";
import { client } from "../dbConfig.js";
import { authMiddleware } from "../middlewares/authMiddleware.js";
import { applyDiscounts } from "../utils/discountEngine.js";

const router = express.Router();

const dbName = process.env.DB_NAME || "glamzi_ecommerce";
const db = client.db(dbName);

const Carts = db.collection("carts");
const Products = db.collection("products");

/* ===============================
   HELPERS
=============================== */
function toObjectId(id) {
  if (!id) return null;
  try {
    const s = String(id).trim();
    if (!ObjectId.isValid(s)) return null;
    return new ObjectId(s);
  } catch {
    return null;
  }
}

function safeNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function safeInt(v, fallback = 1) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeCouponCode(code) {
  const c = String(code || "").trim();
  if (!c) return "";
  return c.toUpperCase().replace(/\s+/g, "");
}

// Resolve productId from various cart item schemas
function resolveProductId(item) {
  return (
    item?.productId ||
    item?.product?._id ||
    item?.product?.id ||
    item?.product?.productId ||
    null
  );
}

// Resolve quantity from various cart item schemas
function resolveQuantity(item) {
  const q = item?.quantity ?? item?.qty ?? 1;
  const n = safeInt(q, 1);
  return n > 0 ? n : 1;
}

/**
 * Builds normalized engineItems:
 * [{ productId, price, quantity, sellerId }]
 *
 * Price source priority:
 * 1) DB product.price (authoritative)
 * 2) embedded item.product.price
 */
async function buildEngineItemsFromCart(cart) {
  const cartItems = Array.isArray(cart?.items) ? cart.items : [];
  if (cartItems.length === 0) return { engineItems: [], resolvedItems: [] };

  // Collect product ids
  const productIdStrings = cartItems
    .map(resolveProductId)
    .map((id) => (id ? String(id) : ""))
    .filter(Boolean);

  // Fetch products from DB (authoritative pricing)
  const objIds = productIdStrings.map(toObjectId).filter(Boolean);
  const dbProducts = objIds.length
    ? await Products.find({ _id: { $in: objIds } })
        .project({ price: 1, userId: 1, title: 1, sellingPrice: 1 })
        .toArray()
    : [];

  console.log("[cartPricing] Cart items:", cartItems.length, "Product IDs:", productIdStrings, "DB products found:", dbProducts.length);

  const dbMap = new Map(dbProducts.map((p) => [String(p._id), p]));

  const resolvedItems = [];
  const engineItems = [];

  for (const item of cartItems) {
    const pidRaw = resolveProductId(item);
    if (!pidRaw) continue;

    const productId = String(pidRaw);
    const qty = resolveQuantity(item);

    const dbP = dbMap.get(productId);

    // ✅ FIX: Check multiple price field names (price, sellingPrice)
    // Prefer DB price ONLY if it is a finite number, else fall back to embedded product price.
    const dbPrice = safeNumber(dbP?.price, NaN);
    const dbSellingPrice = safeNumber(dbP?.sellingPrice, NaN);
    const embeddedPrice = safeNumber(item?.product?.price, NaN);
    const embeddedSellingPrice = safeNumber(item?.product?.sellingPrice, NaN);
    const itemPrice = safeNumber(item?.price, NaN);
    
    // Priority: dbPrice > dbSellingPrice > embeddedPrice > embeddedSellingPrice > itemPrice
    const chosenPrice = Number.isFinite(dbPrice) ? dbPrice 
      : Number.isFinite(dbSellingPrice) ? dbSellingPrice
      : Number.isFinite(embeddedPrice) ? embeddedPrice
      : Number.isFinite(embeddedSellingPrice) ? embeddedSellingPrice
      : itemPrice;

    const finalPrice =
      Number.isFinite(chosenPrice) && chosenPrice >= 0 ? chosenPrice : null;
    if (finalPrice === null) continue;

    // Canonical sellerId rule: sellerId is product.userId (string)
    const sellerId =
      dbP?.userId != null
        ? String(dbP.userId)
        : item?.sellerId != null
        ? String(item.sellerId)
        : item?.product?.userId != null
        ? String(item.product.userId)
        : "";

    const normalized = {
      productId,
      price: finalPrice,
      quantity: qty,
      sellerId,
    };

    engineItems.push(normalized);

    // Helpful for UI/debug
    resolvedItems.push({
      ...normalized,
      title: item?.product?.title || dbP?.title || "",
      source: dbP ? "db" : "embedded",
    });
  }

  return { engineItems, resolvedItems };
}

/* ===============================
   ROUTE: GET/POST /api/cart/pricing
   - Computes subtotal, discounts, grandTotal using discount engine
=============================== */
async function pricingHandler(req, res) {
  try {
    // Accept tokens that encode either `_id` or `id`
    const userId = req.user?._id || req.user?.id;
    console.log("[pricingHandler] userId:", userId);
    
    if (!userId) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    const userObjId = toObjectId(userId);
    if (!userObjId) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    // Optional BUY_NOW style payload support (kept safe)
    // If frontend sends items explicitly, we price those, otherwise we price the stored cart.
    const explicitItems = Array.isArray(req.body?.items) ? req.body.items : null;

    let cart = null;
    let engineItems = [];
    let resolvedItems = [];

    if (explicitItems && explicitItems.length > 0) {
      // Normalize explicit items (expects productId / product._id / price / quantity)
      const tmpCart = { items: explicitItems };
      const built = await buildEngineItemsFromCart(tmpCart);
      engineItems = built.engineItems;
      resolvedItems = built.resolvedItems;
    } else {
      // IMPORTANT: Use ObjectId lookup first (matches getOrCreateCart behavior)
      cart = await Carts.findOne({ userId: userObjId });
      console.log("[pricingHandler] Cart found by ObjectId:", !!cart);
      if (!cart) {
        // Fallback to string lookup for legacy data
        cart = await Carts.findOne({ userId: String(userId) });
        console.log("[pricingHandler] Cart found by string userId:", !!cart);
      }
      console.log("[pricingHandler] Cart items count:", cart?.items?.length || 0);
      console.log("[pricingHandler] Sample cart item:", JSON.stringify(cart?.items?.[0] || {}).slice(0, 500));
      
      const built = await buildEngineItemsFromCart(cart || {});
      engineItems = built.engineItems;
      resolvedItems = built.resolvedItems;
      console.log("[pricingHandler] Engine items count:", engineItems.length);
      console.log("[pricingHandler] Sample engine item:", JSON.stringify(engineItems[0] || {}));
    }

    // Coupon code: can come from cart storage or request
    const storedCoupon =
      cart?.adminCoupon?.code ||
      cart?.adminCouponCode ||
      cart?.couponCode ||
      cart?.coupon?.code ||
      cart?.coupon ||
      cart?.appliedCouponCode ||
      "";

    const requestedCouponCode = normalizeCouponCode(
      req.query?.couponCode || req.body?.couponCode || storedCoupon
    );

    // Subtotal (pre-discount)
    const subtotal = engineItems.reduce(
      (sum, it) => sum + safeNumber(it.price, 0) * safeNumber(it.quantity, 0),
      0
    );

    // Shipping calculation: free if subtotal > 3000, else 150
    const shippingFromRequest = safeNumber(req.body?.shipping, null);
    const shipping = shippingFromRequest !== null 
      ? shippingFromRequest 
      : (subtotal > 3000 ? 0 : (engineItems.length > 0 ? 150 : 0));

    // Apply discount engine
    // applyDiscounts(cart, context) where:
    // - cart = { items, shippingFee }
    // - context = { db, couponCode }
    const engine = await applyDiscounts(
      {
        items: engineItems,
        shippingFee: shipping,
      },
      {
        db,
        couponCode: requestedCouponCode || null,
      }
    );

    // Normalize engine outputs safely
    const appliedAdminCode =
      engine?.appliedAdmin?.priceDiscount?.code ||
      engine?.appliedAdmin?.coupon?.code ||
      engine?.appliedCoupon?.code ||
      "";

    const discountTotal =
      safeNumber(engine?.totals?.discountTotal, NaN) ??
      safeNumber(engine?.totals?.totalDiscount, NaN);

    const grandTotal =
      safeNumber(engine?.totals?.grandTotal, NaN) ??
      safeNumber(engine?.totals?.total, NaN) ??
      safeNumber(
        subtotal -
          (Number.isFinite(discountTotal) ? discountTotal : 0) +
          shipping,
        0
      );

    const normalizedDiscountTotal = Number.isFinite(discountTotal)
      ? discountTotal
      : safeNumber(subtotal + shipping - grandTotal, 0);

    // Coupon UI visibility
    const requestedCoupon = requestedCouponCode
      ? { code: requestedCouponCode }
      : null;
    const appliedCoupon = appliedAdminCode
      ? { code: String(appliedAdminCode).toUpperCase() }
      : null;

    let couponStatus = "none"; // none|applied|not_eligible
    let couponMessage = "";

    if (requestedCoupon) {
      if (appliedCoupon && appliedCoupon.code === requestedCoupon.code) {
        couponStatus = "applied";
        couponMessage = "Coupon applied.";
      } else {
        couponStatus = "not_eligible";
        // Prefer engine-provided reason fields if available
        couponMessage =
          engine?.meta?.couponMessage ||
          engine?.meta?.couponReason ||
          engine?.errors?.coupon ||
          "Coupon saved but not eligible (expired, disabled, or minimum cart not met).";
      }
    }

    const pricing = {
      currency: "NPR",
      subtotal,
      shipping,
      discountTotal: normalizedDiscountTotal,
      grandTotal,

      // Keep details for UI + debugging
      engineItems: resolvedItems, // normalized view of priced items
      requestedCoupon,
      appliedCoupon,
      couponStatus,
      couponMessage,

      // Expose the raw engine only if you want (optional, can remove in strict prod)
      engine: engine || null,

      // ✅ Optional: helpful debug hint when subtotal is 0 but cart exists
      debug:
        engineItems.length === 0
          ? {
              hint:
                "engineItems is empty. Check cart item schema: productId or product._id must exist; price must be numeric.",
              cartItemsCount: Array.isArray(cart?.items) ? cart.items.length : explicitItems?.length || 0,
            }
          : null,
    };

    // Backward compatible response keys
    return res.json({
      success: true,
      pricing,
      totals: {
        subtotal: pricing.subtotal,
        shipping: pricing.shipping,
        shippingFee: pricing.shipping, // alias for frontend compatibility
        shippingDue: pricing.shipping, // alias for frontend compatibility
        discountTotal: pricing.discountTotal,
        grandTotal: pricing.grandTotal,
        sellerDiscountTotal: 0, // placeholder for now
        adminDiscountTotal: pricing.discountTotal,
        shippingDiscount: 0, // placeholder for now
        discountedSubtotal: pricing.subtotal - pricing.discountTotal,
      },
      items: pricing.engineItems,
    });
  } catch (err) {
    console.error("cart pricing error:", err);
    return res.status(500).json({
      success: false,
      message: "Failed to compute cart pricing",
    });
  }
}

router.get("/pricing", authMiddleware, pricingHandler);
router.post("/pricing", authMiddleware, pricingHandler);

export default router;
