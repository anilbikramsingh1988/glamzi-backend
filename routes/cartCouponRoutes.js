// routes/cartCouponRoutes.js
// ===============================
// CART: APPLY / CLEAR ADMIN COUPON (Cart Snapshot)
// POST   /api/cart/coupon   { code }
// DELETE /api/cart/coupon
//
// Stores on cart:
//   cart.adminCoupon = { code, appliedAt }
//
// Production-grade hardening:
// - Customer-only
// - Normalizes coupon code consistently (uppercase + remove whitespace)
// - Validates coupon using unified schema first:
//     { authority:"admin", codeType:"coupon", code }
// - Enforces lifecycle: deletedAt/disabledAt + status/isActive + date window
// - Idempotent apply/remove
// - ✅ Auto-creates cart if missing
// - ✅ NEW: Enforce minCartSubtotal at APPLY time (UX)
// - ✅ NEW: Reject applying coupon to empty cart (UX)
//
// Mount recommended:
//   app.use("/api/cart", cartCouponRoutes);
// ===============================

import express from "express";
import dotenv from "dotenv";
import { ObjectId } from "mongodb";

import { client } from "../dbConfig.js";
import { authMiddleware } from "../middlewares/authMiddleware.js";

dotenv.config();

const router = express.Router();

const dbName = process.env.DB_NAME || "glamzi_ecommerce";
const db = client.db(dbName);

const Carts = db.collection("carts");
const Discounts = db.collection("discounts");
const Products = db.collection("products");

/* ===============================
   Helpers
=============================== */
const nowUtc = () => new Date();

function safeStr(v) {
  return String(v ?? "").trim();
}

function getAuthUserId(req) {
  const id = req.user?._id || req.user?.id || req.user?.userId;
  return id ? String(id) : "";
}

function ensureCustomer(req, res) {
  const role = String(req.user?.role || "").toLowerCase();
  if (!["customer", "user"].includes(role)) {
    res.status(403).json({ success: false, message: "Customer access only" });
    return false;
  }
  return true;
}

function normalizeCouponCode(code) {
  const c = safeStr(code).toUpperCase().replace(/\s+/g, "");
  if (!/^[A-Z0-9_-]{3,30}$/.test(c)) return "";
  return c;
}

function toObjectIdOrNull(id) {
  try {
    if (!id) return null;
    const s = String(id).trim();
    if (!ObjectId.isValid(s)) return null;
    return new ObjectId(s);
  } catch {
    return null;
  }
}

function asDateOrNull(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function inWindow(doc, now = nowUtc()) {
  const s = asDateOrNull(doc?.startAt ?? doc?.startsAt);
  const e = asDateOrNull(doc?.endAt ?? doc?.endsAt);
  if (s && s > now) return false;
  if (e && e < now) return false;
  return true;
}

function isDeleted(doc) {
  return !(doc && (doc.deletedAt == null || doc.deletedAt === undefined));
}

function isActiveCoupon(doc) {
  const st = String(doc?.status || "").toLowerCase();

  if (
    !!doc?.disabledAt ||
    st === "inactive" ||
    st === "disabled" ||
    st === "paused" ||
    st === "expired"
  ) {
    return false;
  }

  const activeByStatus = st === "active";
  const activeByBool = doc?.isActive === true;

  if (doc?.status == null && doc?.isActive != null) return activeByBool;

  return activeByStatus || activeByBool;
}

function getMinCartSubtotal(discountDoc) {
  // Unified schema:
  if (discountDoc?.minCartSubtotal != null) {
    const x = Number(discountDoc.minCartSubtotal);
    return Number.isFinite(x) && x >= 0 ? x : 0;
  }
  // Legacy schema fallback:
  if (discountDoc?.coupon?.minCartValue != null) {
    const x = Number(discountDoc.coupon.minCartValue);
    return Number.isFinite(x) && x >= 0 ? x : 0;
  }
  return 0;
}

async function getOrCreateCart(userIdStr) {
  const userId = String(userIdStr || "");
  if (!userId) return null;

  // Try ObjectId lookup first (matches how getOrCreateCart in cartRoutes.js stores carts)
  const userOid = toObjectIdOrNull(userId);
  let cart = null;
  
  if (userOid) {
    cart = await Carts.findOne({ userId: userOid });
  }
  
  // Fallback to string lookup for legacy carts
  if (!cart) {
    cart = await Carts.findOne({ userId });
  }

  if (!cart) {
    const now = nowUtc();
    // Create with ObjectId to match cartRoutes.js behavior
    const r = await Carts.insertOne({
      userId: userOid || userId,
      items: [],
      createdAt: now,
      updatedAt: now,
    });
    cart = { _id: r.insertedId, userId: userOid || userId, items: [], createdAt: now, updatedAt: now };
  }
  return cart;
}

/**
 * Compute cart subtotal using Products collection.
 * Uses a robust price fallback chain to avoid schema mismatch.
 */
function resolveUnitPrice(productDoc, cartItem) {
  const p = productDoc || {};
  const ci = cartItem || {};

  const candidates = [
    p.salePrice,
    p.price,
    p?.pricing?.salePrice,
    p?.pricing?.price,
    ci.price, // if cart stored snapshot price
  ];

  for (const v of candidates) {
    const x = Number(v);
    if (Number.isFinite(x) && x >= 0) return x;
  }
  return 0;
}

async function computeCartSubtotal(cart) {
  const items = Array.isArray(cart?.items) ? cart.items : [];
  if (!items.length) return 0;

  const productIds = items
    .map((it) => String(it?.productId || it?._id || it?.id || "").trim())
    .filter(Boolean);

  const objectIds = productIds.map(toObjectIdOrNull).filter(Boolean);
  if (!objectIds.length) return 0;

  const products = await Products.find({ _id: { $in: objectIds } }).toArray();
  const map = new Map(products.map((p) => [String(p._id), p]));

  let subtotal = 0;
  for (const it of items) {
    const pid = String(it?.productId || it?._id || it?.id || "").trim();
    const p = map.get(pid);
    if (!p) continue;

    const qty = Math.max(1, Math.floor(Number(it?.quantity || 1)));
    const unit = resolveUnitPrice(p, it);
    subtotal += unit * qty;
  }
  return subtotal;
}

/**
 * Unified schema FIRST:
 *   { authority:"admin", codeType:"coupon", code }
 *
 * Optional legacy fallback:
 *   { scope:"admin", type:"cart_coupon", coupon:{ code }, status, startAt, endAt }
 */
async function findAdminCouponByCode(code) {
  const now = nowUtc();

  // Schema A (unified)
  const a = await Discounts.findOne({
    authority: "admin",
    codeType: "coupon",
    code,
    $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
  });

  if (a) {
    if (isDeleted(a)) return null;
    if (!isActiveCoupon(a)) return null;
    if (!inWindow(a, now)) return null;
    return a;
  }

  // Schema B (legacy fallback)
  const b = await Discounts.findOne({
    scope: "admin",
    type: "cart_coupon",
    "coupon.code": code,
  });

  if (b) {
    const st = String(b?.status || "").toLowerCase();
    if (st !== "active") return null;
    if (!inWindow(b, now)) return null;
    return b;
  }

  return null;
}

/* ===============================
   Routes
=============================== */

async function applyCoupon(req, res) {
  try {
    if (!ensureCustomer(req, res)) return;

    const userIdStr = getAuthUserId(req);
    if (!userIdStr) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    const code = normalizeCouponCode(req.body?.code);
    if (!code) {
      return res.status(400).json({
        success: false,
        message: "Invalid coupon code",
        reason: "INVALID_CODE",
      });
    }

    const coupon = await findAdminCouponByCode(code);
    if (!coupon) {
      return res.status(400).json({
        success: false,
        message: "Coupon invalid or not active",
        reason: "NOT_ACTIVE",
      });
    }

    const cart = await getOrCreateCart(userIdStr);
    if (!cart?._id) {
      return res.status(500).json({ success: false, message: "Failed to load cart" });
    }

    // ✅ UX: refuse applying to empty cart
    const cartItems = Array.isArray(cart.items) ? cart.items : [];
    if (!cartItems.length) {
      return res.status(400).json({
        success: false,
        message: "Add items to your cart before applying a coupon",
        reason: "EMPTY_CART",
      });
    }

    // ✅ UX: enforce minCartSubtotal at APPLY time
    const cartSubtotal = await computeCartSubtotal(cart);
    const minCartSubtotal = getMinCartSubtotal(coupon);

    if (minCartSubtotal > 0 && cartSubtotal < minCartSubtotal) {
      return res.status(400).json({
        success: false,
        message: `Minimum cart value ${minCartSubtotal} required for this coupon`,
        reason: "MIN_CART_SUBTOTAL",
        minCartSubtotal,
        cartSubtotal,
      });
    }

    const alreadyApplied =
      String(cart?.adminCoupon?.code || "") === code && !!cart?.adminCoupon?.appliedAt;

    if (!alreadyApplied) {
      await Carts.updateOne(
        { _id: cart._id },
        {
          $set: {
            adminCoupon: { code, appliedAt: nowUtc() },
            updatedAt: nowUtc(),
          },
        }
      );
    } else {
      await Carts.updateOne({ _id: cart._id }, { $set: { updatedAt: nowUtc() } });
    }

    return res.json({
      success: true,
      message: "Coupon applied",
      adminCoupon: { code },
    });
  } catch (err) {
    console.error("POST /api/cart/coupon error:", err);
    return res.status(500).json({ success: false, message: "Failed to apply coupon" });
  }
}

async function removeCoupon(req, res) {
  try {
    if (!ensureCustomer(req, res)) return;

    const userIdStr = getAuthUserId(req);
    if (!userIdStr) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    const cart = await getOrCreateCart(userIdStr);
    if (!cart?._id) {
      return res.status(500).json({ success: false, message: "Failed to load cart" });
    }

    if (!cart?.adminCoupon) {
      return res.json({ success: true, message: "Coupon removed" });
    }

    await Carts.updateOne(
      { _id: cart._id },
      { $unset: { adminCoupon: "" }, $set: { updatedAt: nowUtc() } }
    );

    return res.json({ success: true, message: "Coupon removed" });
  } catch (err) {
    console.error("DELETE /api/cart/coupon error:", err);
    return res.status(500).json({ success: false, message: "Failed to remove coupon" });
  }
}

// Canonical
router.post("/coupon", authMiddleware, applyCoupon);
router.delete("/coupon", authMiddleware, removeCoupon);

// Backward/lenient
router.post("/", authMiddleware, applyCoupon);
router.delete("/", authMiddleware, removeCoupon);

export default router;
