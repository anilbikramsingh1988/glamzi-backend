// routes/cartRoutes.js
import express from "express";
import { ObjectId } from "mongodb";
import { client } from "../dbConfig.js";
import { authMiddleware } from "../middlewares/authMiddleware.js";
import { applyDiscounts } from "../utils/discountEngine.js"; // ✅ unified engine

const router = express.Router();

const dbName = process.env.DB_NAME || "glamzi_ecommerce";
const db = client.db(dbName);

const Carts = db.collection("carts");
const Products = db.collection("products");
const Sellers = db.collection("sellers");
const Users = db.collection("users");
const Discounts = db.collection("discounts"); // ✅ admin coupons live here

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

function normalizeIdString(idLike) {
  if (!idLike) return "";
  try {
    return String(idLike);
  } catch {
    return "";
  }
}

function safeString(v) {
  return typeof v === "string" ? v.trim() : "";
}

function normalizeCouponCode(code) {
  const c = safeString(code).toUpperCase().replace(/\s+/g, "");
  // A-Z, 0-9, underscore, hyphen; 3-30 chars
  if (!/^[A-Z0-9_-]{3,30}$/.test(c)) return "";
  return c;
}

function asDateOrNull(v) {
  if (!v) return null;
  const dt = new Date(v);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

function getStart(d) {
  return d?.startAt ?? d?.startsAt ?? null;
}

function getEnd(d) {
  return d?.endAt ?? d?.endsAt ?? null;
}

function inWindow(d, now = new Date()) {
  const s = asDateOrNull(getStart(d));
  const e = asDateOrNull(getEnd(d));
  const sOk = !s || s <= now;
  const eOk = !e || e >= now;
  return sOk && eOk;
}

function normalizeAuthority(d) {
  return String(d?.authority || "").trim().toLowerCase();
}

function normalizeCodeType(d) {
  const ct = String(d?.codeType || "").trim().toLowerCase();
  if (ct === "coupon" || ct === "campaign") return ct;

  // Backward compatible inference
  if (d?.coupon?.code || d?.code) return "coupon";
  return "campaign";
}

function normalizeDiscountKind(d) {
  // ✅ CANONICAL: percentage | flat | free_shipping
  const raw = String(d?.kind || d?.discountType || "").trim().toLowerCase();

  // map old UI naming -> engine naming
  if (raw === "fixed") return "flat"; // ✅ IMPORTANT FIX
  if (raw === "flat" || raw === "percentage" || raw === "free_shipping") return raw;

  // allow legacy synonyms if any
  if (raw === "percent") return "percentage";

  return "";
}

function isActiveDiscountDoc(d) {
  const byBool = d?.isActive === true;
  const byStatus = String(d?.status || "").toLowerCase() === "active";
  return byBool || byStatus;
}

function isDisabledDiscountDoc(d) {
  if (d?.disabledAt) return true;
  const st = String(d?.status || "").toLowerCase();
  if (st === "disabled" || st === "inactive") return true;
  return false;
}

/**
 * Recalc totals and store in cart.totals (raw totals, no discounts)
 * NOTE: Keep as-is (shippingFee currently 0 in your cart)
 */
function calculateTotals(items) {
  let subtotal = 0;
  let totalQuantity = 0;

  for (const item of items || []) {
    const price = Number(item?.price || 0);
    const qty = Number(item?.quantity || 0);
    subtotal += price * qty;
    totalQuantity += qty;
  }

  const shippingFee = 0;
  const grandTotal = subtotal + shippingFee;

  return {
    subtotal,
    shippingFee,
    grandTotal,
    totalQuantity,
  };
}

/**
 * ✅ HARD RULE: sellerId = product.userId
 */
function resolveSellerIdFromProduct(product) {
  const sellerId = product?.userId?.toString?.() || product?.userId || null;
  return sellerId ? String(sellerId) : null;
}

/**
 * Best-effort category resolver (varies by your product schema)
 */
function resolveCategoryIdFromProduct(product) {
  const c =
    product?.categoryId?.toString?.() ||
    product?.categoryId ||
    product?.category?._id?.toString?.() ||
    product?.category?._id ||
    product?.category?.id?.toString?.() ||
    product?.category?.id ||
    product?.category ||
    null;

  return c ? String(c) : null;
}

async function getOrCreateCart(userId) {
  const uid = toObjectId(userId);
  if (!uid) return null;

  let cart = await Carts.findOne({ userId: uid });

  if (!cart) {
    const newCart = {
      userId: uid,
      mode: "CART",
      items: [],
      totals: {
        subtotal: 0,
        shippingFee: 0,
        grandTotal: 0,
        totalQuantity: 0,
      },
      // adminCoupon snapshot:
      // adminCoupon: { code, discountId, kind, value, ... }
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const { insertedId } = await Carts.insertOne(newCart);
    cart = { _id: insertedId, ...newCart };
  } else {
    const needsMode = !cart.mode;
    const needsTotals = !cart.totals || typeof cart.totals !== "object";
    if (needsMode || needsTotals) {
      const totals = calculateTotals(cart.items || []);
      await Carts.updateOne(
        { _id: cart._id },
        { $set: { mode: cart.mode || "CART", totals, updatedAt: new Date() } }
      );
      cart = await Carts.findOne({ _id: cart._id });
    }
  }

  return cart;
}

/**
 * Enrich cart items using Products so discount engine has categoryId.
 * NOTE: does NOT write back to cart (read-only enrichment).
 */
async function buildDiscountCartInput(cart) {
  const items = Array.isArray(cart?.items) ? cart.items : [];

  const productIds = items.map((it) => toObjectId(it?.productId)).filter(Boolean);

  const products = await Products.find(
    { _id: { $in: productIds } },
    { projection: { _id: 1, userId: 1, categoryId: 1, category: 1 } }
  ).toArray();

  const map = new Map(products.map((p) => [String(p._id), p]));

  const enriched = items.map((it) => {
    const pid = normalizeIdString(it?.productId);
    const p = map.get(pid);

    const sellerId = it?.sellerId || resolveSellerIdFromProduct(p);
    const categoryId = resolveCategoryIdFromProduct(p);

    return {
      productId: pid || null,
      quantity: Math.max(1, Math.floor(Number(it?.quantity || 1))),
      price: Math.max(0, Number(it?.price || 0)),
      sellerId: sellerId ? String(sellerId) : null,
      categoryId: categoryId ? String(categoryId) : null,

      // Optional passthrough fields
      title: it?.title,
      image: it?.image,
    };
  });

  const shippingFee = Math.max(0, Number(cart?.totals?.shippingFee || 0));

  return {
    items: enriched,
    shippingFee,
  };
}

/* ===============================
   ✅ COUPON RESOLVER (UNIFIED)
   - authority: "admin"
   - codeType: "coupon"
   - kind: "percentage" | "flat"
=============================== */
async function findActiveAdminCouponByCode(code) {
  const now = new Date();
  const normalizedCode = normalizeCouponCode(code);
  if (!normalizedCode) return null;

  // Prefer unified query (still tolerant if older docs exist)
  const candidates = await Discounts.find({
    authority: "admin",
    code: normalizedCode,
    $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
  })
    .sort({ priority: -1, updatedAt: -1 })
    .limit(10)
    .toArray();

  const valid = (candidates || [])
    .filter((d) => normalizeAuthority(d) === "admin")
    .filter((d) => normalizeCodeType(d) === "coupon")
    .filter((d) => isActiveDiscountDoc(d) && !isDisabledDiscountDoc(d))
    .filter((d) => inWindow(d, now))
    .filter((d) => {
      const k = normalizeDiscountKind(d);
      return k === "percentage" || k === "flat";
    });

  return valid[0] || null;
}

/**
 * Centralized coupon resolver for apply endpoint.
 * Soft checks usageLimit + minCartSubtotal here; hard enforcement belongs in ordersRoutes.js.
 */
async function findValidAdminCouponByCode(code, cartSubtotal = null) {
  const normalizedCode = normalizeCouponCode(code);
  if (!normalizedCode) return { ok: false, message: "Invalid coupon code format" };

  const coupon = await findActiveAdminCouponByCode(normalizedCode);
  if (!coupon) return { ok: false, message: "Coupon not found or inactive" };

  // Soft usage check
  const usageLimit = coupon.usageLimitTotal ?? coupon.usageLimit ?? null;
  if (
    Number.isInteger(usageLimit) &&
    Number(coupon.usedCount || 0) >= Number(usageLimit)
  ) {
    return { ok: false, message: "Coupon usage limit reached" };
  }

  // Soft min cart check (helps UX)
  const minCartSubtotal = Number(coupon.minCartSubtotal ?? coupon.coupon?.minCartValue ?? 0);
  if (cartSubtotal != null && Number.isFinite(minCartSubtotal) && minCartSubtotal > 0) {
    if (Number(cartSubtotal) < minCartSubtotal) {
      return {
        ok: false,
        message: `Minimum cart value is Rs ${Math.round(minCartSubtotal)} for this coupon`,
      };
    }
  }

  return { ok: true, doc: coupon };
}

/* ===============================
   COUPON APPLY/REMOVE
=============================== */

// POST /api/cart/coupon/apply
// Body: { code }
router.post("/coupon/apply", authMiddleware, async (req, res) => {
  try {
    const userId = req.user?.id || req.user?._id;
    const role = String(req.user?.role || "").toLowerCase();

    if (!userId || role !== "customer") {
      return res.status(403).json({ success: false, message: "Customer access only" });
    }

    const code = normalizeCouponCode(req.body?.code);
    if (!code) {
      return res.status(400).json({ success: false, message: "Invalid coupon code" });
    }

    const cart = await getOrCreateCart(userId);
    if (!cart) {
      return res.status(400).json({ success: false, message: "Invalid user session" });
    }

    const cartSubtotal = Number(cart?.totals?.subtotal || 0);

    const found = await findValidAdminCouponByCode(code, cartSubtotal);
    if (!found.ok) {
      return res.status(400).json({ success: false, message: found.message });
    }

    const coupon = found.doc;

    const kind = normalizeDiscountKind(coupon); // percentage | flat
    const snapshot = {
      discountId: normalizeIdString(coupon._id),
      code: normalizeCouponCode(coupon.code),
      codeType: "coupon",
      authority: "admin",
      funding: "admin",

      kind: kind || "percentage",
      value: Number(coupon.value || 0),

      scope: coupon.scope || "cart",
      minCartSubtotal: coupon.minCartSubtotal ?? null,
      maxDiscount: coupon.maxDiscount ?? null,

      startAt: getStart(coupon),
      endAt: getEnd(coupon),

      appliedAt: new Date(),
    };

    await Carts.updateOne(
      { _id: cart._id },
      { $set: { adminCoupon: snapshot, updatedAt: new Date() } }
    );

    const updatedCart = await Carts.findOne({ _id: cart._id });

    // Return a pricing quote immediately (recommended for checkout UX)
    const discountCart = await buildDiscountCartInput(updatedCart);
    const pricing = await applyDiscounts(discountCart, { db, couponCode: snapshot.code });

    return res.json({ success: true, cart: updatedCart, pricing, adminCoupon: snapshot });
  } catch (err) {
    console.error("POST /cart/coupon/apply error:", err);
    return res.status(500).json({ success: false, message: "Failed to apply coupon" });
  }
});

// DELETE /api/cart/coupon/remove
router.delete("/coupon/remove", authMiddleware, async (req, res) => {
  try {
    const userId = req.user?.id || req.user?._id;
    const role = String(req.user?.role || "").toLowerCase();

    if (!userId || role !== "customer") {
      return res.status(403).json({ success: false, message: "Customer access only" });
    }

    const cart = await getOrCreateCart(userId);
    if (!cart) {
      return res.status(400).json({ success: false, message: "Invalid user session" });
    }

    await Carts.updateOne(
      { _id: cart._id },
      { $unset: { adminCoupon: "" }, $set: { updatedAt: new Date() } }
    );

    const updatedCart = await Carts.findOne({ _id: cart._id });

    // Return fresh quote without coupon
    const discountCart = await buildDiscountCartInput(updatedCart);
    const pricing = await applyDiscounts(discountCart, { db, couponCode: "" });

    return res.json({ success: true, cart: updatedCart, pricing });
  } catch (err) {
    console.error("DELETE /cart/coupon/remove error:", err);
    return res.status(500).json({ success: false, message: "Failed to remove coupon" });
  }
});

/* ===============================
   GET /api/cart
   Optional query: ?couponCode=GLAMZI10
=============================== */
router.get("/", authMiddleware, async (req, res) => {
  try {
    const userId = req.user?.id || req.user?._id;
    console.log("[GET /cart] userId:", userId);
    const cart = await getOrCreateCart(userId);
    console.log("[GET /cart] cart items count:", cart?.items?.length || 0);

    if (!cart) {
      return res.status(400).json({ success: false, message: "Invalid user session" });
    }

    const items = Array.isArray(cart.items) ? cart.items : [];
    let sellerIdUpdated = false;

    const missingSellerProductIds = items
      .filter((it) => !it?.sellerId)
      .map((it) => toObjectId(it?.productId))
      .filter(Boolean);

    if (missingSellerProductIds.length) {
      const products = await Products.find(
        { _id: { $in: missingSellerProductIds } },
        { projection: { _id: 1, userId: 1 } }
      ).toArray();

      const productMap = new Map(products.map((p) => [String(p._id), p]));

      for (const item of items) {
        if (item?.sellerId) continue;
        const pid = normalizeIdString(item?.productId);
        const product = productMap.get(pid);
        const sellerId = resolveSellerIdFromProduct(product);
        if (sellerId) {
          item.sellerId = sellerId;
          sellerIdUpdated = true;
        }
      }
    }

    // Keep your existing raw totals behavior
    const computedTotals = calculateTotals(items);
    const currentTotals = cart.totals || {};
    const changed =
      Number(currentTotals.subtotal || 0) !== Number(computedTotals.subtotal || 0) ||
      Number(currentTotals.shippingFee || 0) !== Number(computedTotals.shippingFee || 0) ||
      Number(currentTotals.grandTotal || 0) !== Number(computedTotals.grandTotal || 0) ||
      Number(currentTotals.totalQuantity || 0) !== Number(computedTotals.totalQuantity || 0);

    let freshCart = cart;
    if (changed || sellerIdUpdated) {
      await Carts.updateOne(
        { _id: cart._id },
        { $set: { items, totals: computedTotals, updatedAt: new Date() } }
      );
      freshCart = await Carts.findOne({ _id: cart._id });
    }

    const cartItems = Array.isArray(freshCart?.items) ? freshCart.items : [];
    const sellerIds = cartItems
      .map((it) => toObjectId(it?.sellerId))
      .filter(Boolean);
    const sellers = sellerIds.length
      ? await Sellers.find(
          { _id: { $in: sellerIds } },
          { projection: { _id: 1, storeName: 1, shopName: 1, name: 1 } }
        ).toArray()
      : [];
    const sellerMap = new Map(sellers.map((s) => [String(s._id), s]));
    const missingSellerIds = sellerIds.filter((sid) => !sellerMap.has(String(sid)));
    if (missingSellerIds.length) {
      const users = await Users.find(
        { _id: { $in: missingSellerIds }, role: "seller" },
        { projection: { _id: 1, storeName: 1, shopName: 1, name: 1 } }
      ).toArray();
      users.forEach((u) => {
        sellerMap.set(String(u._id), u);
      });
    }
    const enrichedItems = cartItems.map((it) => {
      const sid = normalizeIdString(it?.sellerId);
      const seller = sellerMap.get(sid);
      return seller
        ? {
            ...it,
            seller: {
              _id: seller._id,
              storeName: seller.storeName,
              shopName: seller.shopName,
              name: seller.name,
            },
          }
        : it;
    });
    const responseCart = { ...freshCart, items: enrichedItems };

    const queryCoupon = normalizeCouponCode(req.query?.couponCode);
    const cartCoupon = normalizeCouponCode(freshCart?.adminCoupon?.code);
    const effectiveCouponCode = queryCoupon || cartCoupon || "";

    if (effectiveCouponCode) {
      const discountCart = await buildDiscountCartInput(freshCart);
      const pricing = await applyDiscounts(discountCart, { db, couponCode: effectiveCouponCode });
      return res.json({ success: true, cart: responseCart, pricing });
    }

    return res.json({ success: true, cart: responseCart });
  } catch (err) {
    console.error("GET /cart error:", err);
    return res.status(500).json({ success: false, message: "Failed to load cart" });
  }
});

/* ===============================
   POST /api/cart/pricing
   NOTE: This route is now handled by cartPricingRoutes.js
   Keeping this comment to prevent route conflicts
=============================== */

/* ===============================
   POST /api/cart/add
=============================== */
router.post("/add", authMiddleware, async (req, res) => {
  try {
    const userId = req.user?.id || req.user?._id;
    const { productId, quantity = 1 } = req.body;

    if (!productId) {
      return res.status(400).json({ success: false, message: "productId is required" });
    }

    const pid = toObjectId(productId);
    if (!pid) {
      return res.status(400).json({ success: false, message: "Invalid productId" });
    }

    const qty = Math.max(1, Math.floor(Number(quantity) || 1));

    const cart = await getOrCreateCart(userId);
    if (!cart) {
      return res.status(400).json({ success: false, message: "Invalid user session" });
    }

    const product = await Products.findOne({ _id: pid });
    if (!product) {
      return res.status(404).json({ success: false, message: "Product not found" });
    }

    const sellerId = resolveSellerIdFromProduct(product);
    if (!sellerId) {
      return res.status(400).json({
        success: false,
        message: "Product missing seller mapping (userId).",
      });
    }

    const items = Array.isArray(cart.items) ? cart.items : [];
    const pidStr = normalizeIdString(product._id);

    const existingIndex = items.findIndex((it) => normalizeIdString(it?.productId) === pidStr);

    if (existingIndex > -1) {
      items[existingIndex].quantity =
        Math.max(0, Math.floor(Number(items[existingIndex].quantity || 0))) + qty;

      if (!items[existingIndex].sellerId) {
        items[existingIndex].sellerId = sellerId;
      }
    } else {
      items.push({
        _id: new ObjectId(),
        productId: product._id,
        title: product.title || product.name || "Untitled",
        price: Number(product.price || 0),
        image: product.image || product.images?.[0] || null,
        sellerId,
        quantity: qty,
      });
    }

    const totals = calculateTotals(items);

    await Carts.updateOne(
      { _id: cart._id },
      { $set: { items, totals, updatedAt: new Date() } }
    );

    const updatedCart = await Carts.findOne({ _id: cart._id });
    return res.json({ success: true, cart: updatedCart });
  } catch (err) {
    console.error("POST /cart/add error:", err);
    return res.status(500).json({ success: false, message: "Failed to add to cart" });
  }
});

/* ===============================
   PUT /api/cart/update
=============================== */
router.put("/update", authMiddleware, async (req, res) => {
  try {
    const userId = req.user?.id || req.user?._id;
    const { productId, quantity } = req.body;

    if (!productId || typeof quantity === "undefined") {
      return res.status(400).json({
        success: false,
        message: "productId and quantity are required",
      });
    }

    const pid = toObjectId(productId);
    if (!pid) {
      return res.status(400).json({ success: false, message: "Invalid productId" });
    }

    const qty = Math.floor(Number(quantity));
    if (Number.isNaN(qty) || qty < 0) {
      return res.status(400).json({
        success: false,
        message: "Quantity must be 0 or more",
      });
    }

    const cart = await getOrCreateCart(userId);
    if (!cart) {
      return res.status(400).json({ success: false, message: "Invalid user session" });
    }

    const items = Array.isArray(cart.items) ? cart.items : [];
    const pidStr = normalizeIdString(pid);

    const index = items.findIndex((it) => normalizeIdString(it?.productId) === pidStr);
    if (index === -1) {
      return res.status(404).json({ success: false, message: "Item not found in cart" });
    }

    if (qty === 0) items.splice(index, 1);
    else items[index].quantity = qty;

    const totals = calculateTotals(items);

    await Carts.updateOne(
      { _id: cart._id },
      { $set: { items, totals, updatedAt: new Date() } }
    );

    const updatedCart = await Carts.findOne({ _id: cart._id });
    return res.json({ success: true, cart: updatedCart });
  } catch (err) {
    console.error("PUT /cart/update error:", err);
    return res.status(500).json({ success: false, message: "Failed to update cart" });
  }
});

/* ===============================
   DELETE /api/cart/remove/:productId
=============================== */
router.delete("/remove/:productId", authMiddleware, async (req, res) => {
  try {
    const userId = req.user?.id || req.user?._id;
    const pid = toObjectId(req.params.productId);

    if (!pid) {
      return res.status(400).json({ success: false, message: "Invalid productId" });
    }

    const cart = await getOrCreateCart(userId);
    if (!cart) {
      return res.status(400).json({ success: false, message: "Invalid user session" });
    }

    const items = Array.isArray(cart.items) ? cart.items : [];
    const pidStr = normalizeIdString(pid);

    const nextItems = items.filter((it) => normalizeIdString(it?.productId) !== pidStr);
    if (nextItems.length === items.length) {
      return res.status(404).json({ success: false, message: "Item not found in cart" });
    }

    const totals = calculateTotals(nextItems);

    await Carts.updateOne(
      { _id: cart._id },
      { $set: { items: nextItems, totals, updatedAt: new Date() } }
    );

    const updatedCart = await Carts.findOne({ _id: cart._id });
    return res.json({ success: true, cart: updatedCart });
  } catch (err) {
    console.error("DELETE /cart/remove error:", err);
    return res.status(500).json({ success: false, message: "Failed to remove item" });
  }
});

/* ===============================
   DELETE /api/cart/clear
=============================== */
router.delete("/clear", authMiddleware, async (req, res) => {
  try {
    const userId = req.user?.id || req.user?._id;
    const cart = await getOrCreateCart(userId);

    if (!cart) {
      return res.status(400).json({ success: false, message: "Invalid user session" });
    }

    const totals = calculateTotals([]);

    await Carts.updateOne(
      { _id: cart._id },
      { $set: { items: [], totals, updatedAt: new Date() } }
    );

    const updatedCart = await Carts.findOne({ _id: cart._id });
    return res.json({ success: true, cart: updatedCart });
  } catch (err) {
    console.error("DELETE /cart/clear error:", err);
    return res.status(500).json({ success: false, message: "Failed to clear cart" });
  }
});

/* ===============================
   OPTIONAL: Repair endpoint
=============================== */
router.post("/repair-seller-ids", authMiddleware, async (req, res) => {
  try {
    const userId = req.user?.id || req.user?._id;
    const cart = await getOrCreateCart(userId);

    if (!cart) {
      return res.status(400).json({ success: false, message: "Invalid user session" });
    }

    const items = Array.isArray(cart.items) ? cart.items : [];
    let fixed = 0;

    for (const item of items) {
      if (item?.sellerId) continue;

      const pid = toObjectId(item?.productId);
      if (!pid) continue;

      const p = await Products.findOne({ _id: pid }, { projection: { userId: 1 } });

      const sellerId = resolveSellerIdFromProduct(p);
      if (sellerId) {
        item.sellerId = sellerId;
        fixed += 1;
      }
    }

    const totals = calculateTotals(items);

    await Carts.updateOne(
      { _id: cart._id },
      { $set: { items, totals, updatedAt: new Date() } }
    );

    const updatedCart = await Carts.findOne({ _id: cart._id });

    return res.json({
      success: true,
      message: `Repaired ${fixed} cart item(s).`,
      fixed,
      cart: updatedCart,
    });
  } catch (err) {
    console.error("POST /cart/repair-seller-ids error:", err);
    return res.status(500).json({ success: false, message: "Failed to repair cart" });
  }
});

export default router;
