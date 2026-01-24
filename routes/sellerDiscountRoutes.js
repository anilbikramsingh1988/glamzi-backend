// routes/sellerDiscountRoutes.js
import express from "express";
import dotenv from "dotenv";
import { ObjectId } from "mongodb";

import { client } from "../dbConfig.js";
import { authMiddleware, isActiveMiddleware } from "../middlewares/authMiddleware.js";

dotenv.config();
const router = express.Router();

const dbName = process.env.DB_NAME || "glamzi_ecommerce";
const db = client.db(dbName);

const Discounts = db.collection("discounts");
const Users = db.collection("users"); // ✅ NEW (for seller snapshot)

/* ===============================
   GUARDS
=============================== */
const sellerGuard = [authMiddleware, isActiveMiddleware];

function ensureSeller(req, res) {
  const role = String(req.user?.role || "").toLowerCase();
  if (role !== "seller") {
    res.status(403).json({ success: false, message: "Seller access only" });
    return false;
  }
  return true;
}

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

function safeString(v) {
  return typeof v === "string" ? v.trim() : "";
}

function safeNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function safeInt(v) {
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
}

function normalizeScope(scope) {
  const s = String(scope || "").toLowerCase();
  if (["product", "category", "store"].includes(s)) return s;
  return "";
}

function normalizeDiscountType(t) {
  const s = String(t || "").toLowerCase();
  if (["percentage", "percent"].includes(s)) return "percentage";
  if (["flat", "fixed"].includes(s)) return "flat";
  return "";
}

function parseDateOrNull(v) {
  if (v === null || v === undefined || v === "") return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function hasTimeOverlap(aStart, aEnd, bStart, bEnd) {
  // null means open-ended
  const as = aStart ? new Date(aStart).getTime() : null;
  const ae = aEnd ? new Date(aEnd).getTime() : null;
  const bs = bStart ? new Date(bStart).getTime() : null;
  const be = bEnd ? new Date(bEnd).getTime() : null;

  const left = as === null ? -Infinity : as;
  const right = ae === null ? Infinity : ae;
  const left2 = bs === null ? -Infinity : bs;
  const right2 = be === null ? Infinity : be;

  return left <= right2 && left2 <= right;
}

function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function normalizeIdLike(raw) {
  if (!raw) return "";
  if (raw instanceof ObjectId) return String(raw);
  if (isPlainObject(raw) && raw.$oid) return String(raw.$oid).trim();

  try {
    const s = String(raw).trim();
    if (s && s !== "[object Object]") return s;
  } catch {
    // ignore
  }

  if (isPlainObject(raw)) {
    if (raw._id) return normalizeIdLike(raw._id);
    if (raw.id) return normalizeIdLike(raw.id);
    if (raw.userId) return normalizeIdLike(raw.userId);
  }

  try {
    if (raw?.toString) {
      const t = raw.toString();
      if (t && t !== "[object Object]") return String(t).trim();
    }
  } catch {
    // ignore
  }

  return "";
}

// ✅ robust seller id resolver (prevents sellerId: "")
function getAuthedSellerId(req) {
  const raw =
    req.user?._id ??
    req.user?.id ??
    req.user?.userId ??
    req.user?.sub ??
    req.user?.sellerId ??
    req.user?.seller?._id ??
    req.user?.seller?.id ??
    "";

  const s = normalizeIdLike(raw);
  return s || "";
}

// ✅ snapshot builder from req.user (works even if Users lookup fails)
function buildSellerSnapshotFromReq(req, sellerIdStr) {
  const u = req.user || {};
  const storeName =
    safeString(u.storeName) ||
    safeString(u.shopName) ||
    safeString(u.businessName) ||
    safeString(u.name) ||
    safeString(u.fullName) ||
    null;

  const email = safeString(u.email) || null;
  const phone = safeString(u.phone) || safeString(u.mobile) || null;

  const avatar = u.avatar || u.logo || u.storeLogo || u.profileImage || u.image || null;

  const isVerified =
    typeof u.isVerified === "boolean"
      ? u.isVerified
      : typeof u.verified === "boolean"
      ? u.verified
      : null;

  const isActive = typeof u.isActive === "boolean" ? u.isActive : null;

  return {
    id: sellerIdStr || null,
    storeName,
    shopName: safeString(u.shopName) || null,
    email,
    phone,
    avatar,
    isVerified: isVerified === null ? false : !!isVerified,
    isActive,
  };
}

// ✅ best-effort snapshot: DB lookup first, token fallback second
async function loadSellerSnapshot(sellerIdStr, req) {
  const oid = toObjectId(sellerIdStr);

  if (oid) {
    const u = await Users.findOne(
      { _id: oid },
      {
        projection: {
          _id: 1,
          email: 1,
          phone: 1,
          mobile: 1,
          storeName: 1,
          shopName: 1,
          businessName: 1,
          name: 1,
          fullName: 1,
          avatar: 1,
          logo: 1,
          storeLogo: 1,
          profileImage: 1,
          image: 1,
          isVerified: 1,
          verified: 1,
          isActive: 1,
          role: 1,
        },
      }
    );

    if (u) {
      return {
        id: String(u._id),
        storeName:
          safeString(u.storeName) ||
          safeString(u.shopName) ||
          safeString(u.businessName) ||
          safeString(u.name) ||
          safeString(u.fullName) ||
          null,
        shopName: safeString(u.shopName) || null,
        email: safeString(u.email) || null,
        phone: safeString(u.phone) || safeString(u.mobile) || null,
        avatar: u.avatar || u.storeLogo || u.logo || u.profileImage || u.image || null,
        isVerified: typeof u.isVerified === "boolean" ? u.isVerified : !!u.verified,
        isActive: typeof u.isActive === "boolean" ? u.isActive : null,
      };
    }
  }

  return buildSellerSnapshotFromReq(req, sellerIdStr);
}

// ✅ NEW: snapshot is considered “usable” only if it has an id and some identity (storeName/email)
function isUsableSnapshot(snap) {
  if (!snap || typeof snap !== "object") return false;
  const id = safeString(snap.id);
  const storeName = safeString(snap.storeName);
  const email = safeString(snap.email);
  return !!id && (!!storeName || !!email);
}

// ✅ NEW: repair/ensure snapshot on existing discount doc when needed
async function ensureSnapshotForDiscount(existing, req, sellerIdStr) {
  try {
    if (isUsableSnapshot(existing?.sellerSnapshot)) return null;
    const snap = await loadSellerSnapshot(sellerIdStr, req);
    return snap || null;
  } catch {
    return null;
  }
}

function buildActiveSellerDiscountBaseMatch(sellerId) {
  return {
    $and: [
      {
        $or: [{ authority: "seller" }, { createdByRole: "seller" }, { kind: "seller_discount" }],
      },
      { sellerId: String(sellerId) },
      { $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }] },
      { $or: [{ disabled: { $ne: true } }, { disabled: { $exists: false } }] },
      { $or: [{ isActive: true }, { isActive: { $exists: false } }] },
    ],
  };
}

// Returns { ok: true } or { ok:false, message }
async function validateSellerDiscountPayload({
  sellerId,
  scope,
  target,
  discountType,
  value,
  startsAt,
  endsAt,
  minQty,
  maxQty,
  excludeId,
}) {
  const sc = normalizeScope(scope);
  if (!sc) return { ok: false, message: "Invalid scope (product|category|store)" };

  const dt = normalizeDiscountType(discountType);
  if (!dt) return { ok: false, message: "Invalid discountType (percentage|flat)" };

  const val = safeNumber(value);
  if (val === null || val <= 0) return { ok: false, message: "value must be a positive number" };
  if (dt === "percentage" && val > 95) return { ok: false, message: "percentage value too high" };

  const sAt = startsAt ? parseDateOrNull(startsAt) : null;
  const eAt = endsAt ? parseDateOrNull(endsAt) : null;
  if (startsAt && !sAt) return { ok: false, message: "Invalid startsAt date" };
  if (endsAt && !eAt) return { ok: false, message: "Invalid endsAt date" };
  if (sAt && eAt && sAt.getTime() > eAt.getTime()) {
    return { ok: false, message: "startsAt must be before endsAt" };
  }

  const mnq = minQty == null ? null : safeInt(minQty);
  const mxq = maxQty == null ? null : safeInt(maxQty);
  if (mnq !== null && mnq < 1) return { ok: false, message: "minQty must be >= 1" };
  if (mxq !== null && mxq < 1) return { ok: false, message: "maxQty must be >= 1" };
  if (mnq !== null && mxq !== null && mnq > mxq) {
    return { ok: false, message: "minQty must be <= maxQty" };
  }

  let productId = null;
  let categoryId = null;

  if (sc === "product") {
    productId = safeString(target?.productId || target?.id || target?.product);
    if (!productId) return { ok: false, message: "product scope requires target.productId" };
  }

  if (sc === "category") {
    categoryId = safeString(target?.categoryId || target?.id || target?.category);
    if (!categoryId) return { ok: false, message: "category scope requires target.categoryId" };
  }

  const baseMatch = buildActiveSellerDiscountBaseMatch(sellerId);
  const match = { $and: [baseMatch] };

  if (excludeId) {
    const oid = toObjectId(excludeId);
    if (oid) match.$and.push({ _id: { $ne: oid } });
  }

  match.$and.push({ scope: sc });
  if (sc === "product") match.$and.push({ productId });
  if (sc === "category") match.$and.push({ categoryId });

  const candidates = await Discounts.find(match, {
    projection: { _id: 1, startsAt: 1, endsAt: 1 },
  }).toArray();

  for (const c of candidates) {
    if (hasTimeOverlap(sAt, eAt, c.startsAt, c.endsAt)) {
      const msg =
        sc === "store"
          ? "You already have an overlapping active store discount."
          : sc === "product"
          ? "You already have an overlapping active discount for this product."
          : "You already have an overlapping active discount for this category.";
      return { ok: false, message: msg };
    }
  }

  return {
    ok: true,
    parsed: {
      scope: sc,
      discountType: dt,
      value: val,
      startsAt: sAt,
      endsAt: eAt,
      minQty: mnq,
      maxQty: mxq,
      productId,
      categoryId,
    },
  };
}

/* ===============================
   ROUTES: /api/seller/discounts
=============================== */

// GET /api/seller/discounts
router.get("/", sellerGuard, async (req, res) => {
  try {
    if (!ensureSeller(req, res)) return;

    const sellerId = getAuthedSellerId(req);
    if (!sellerId) {
      return res.status(401).json({
        success: false,
        message: "Auth error: missing seller id in token/session",
      });
    }

    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(5, Number(req.query.limit) || 20));
    const skip = (page - 1) * limit;

    const scope = normalizeScope(req.query.scope);
    const status = safeString(req.query.status || "active").toLowerCase();
    const q = safeString(req.query.q);

    const match = {
      sellerId,
      $and: [
        {
          $or: [{ authority: "seller" }, { createdByRole: "seller" }, { kind: "seller_discount" }],
        },
        { $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }] },
      ],
    };

    if (scope) match.scope = scope;

    if (status === "active") {
      match.$and.push({ $or: [{ disabled: { $ne: true } }, { disabled: { $exists: false } }] });
    } else if (status === "disabled") {
      match.$and.push({ disabled: true });
    }

    if (q) {
      const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      match.$and.push({
        $or: [{ name: rx }, { title: rx }, { code: rx }, { description: rx }],
      });
    }

    const pipeline = [
      { $match: match },
      {
        $project: {
          _id: 1,
          sellerId: 1,
          scope: 1,
          productId: 1,
          categoryId: 1,
          name: { $ifNull: ["$name", "$title"] },
          code: 1,
          discountType: 1,
          value: 1,
          minQty: 1,
          maxQty: 1,
          startsAt: 1,
          endsAt: 1,
          isActive: { $ifNull: ["$isActive", true] },
          disabled: { $ifNull: ["$disabled", false] },
          disabledAt: 1,
          disabledBy: 1,
          createdBy: 1,
          sellerSnapshot: 1,
          createdAt: 1,
          updatedAt: 1,
        },
      },
      { $sort: { createdAt: -1, _id: -1 } },
      {
        $facet: {
          items: [{ $skip: skip }, { $limit: limit }],
          total: [{ $count: "count" }],
        },
      },
    ];

    const agg = await Discounts.aggregate(pipeline).toArray();
    const items = agg?.[0]?.items || [];
    const total = agg?.[0]?.total?.[0]?.count || 0;

    res.json({
      success: true,
      page,
      limit,
      total,
      pages: Math.ceil(total / limit) || 1,
      items,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: "Failed to list discounts" });
  }
});

// GET /api/seller/discounts/:id
router.get("/:id", sellerGuard, async (req, res) => {
  try {
    if (!ensureSeller(req, res)) return;

    const sellerId = getAuthedSellerId(req);
    if (!sellerId) {
      return res.status(401).json({
        success: false,
        message: "Auth error: missing seller id in token/session",
      });
    }

    const id = toObjectId(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: "Invalid discount id" });

    const item = await Discounts.findOne({
      _id: id,
      sellerId,
      $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
    });

    if (!item) return res.status(404).json({ success: false, message: "Discount not found" });
    res.json({ success: true, item });
  } catch {
    res.status(500).json({ success: false, message: "Failed to load discount" });
  }
});

// POST /api/seller/discounts
router.post("/", sellerGuard, async (req, res) => {
  try {
    if (!ensureSeller(req, res)) return;

    const sellerId = getAuthedSellerId(req);
    if (!sellerId) {
      return res.status(401).json({
        success: false,
        message: "Auth error: missing seller id in token/session",
      });
    }

    const body = req.body || {};
    const hasStartsAt = Object.prototype.hasOwnProperty.call(body, "startsAt");
    const hasEndsAt = Object.prototype.hasOwnProperty.call(body, "endsAt");
    const hasMinQty = Object.prototype.hasOwnProperty.call(body, "minQty");
    const hasMaxQty = Object.prototype.hasOwnProperty.call(body, "maxQty");

    const v = await validateSellerDiscountPayload({
      sellerId,
      scope: body.scope,
      target: body.target || {},
      discountType: body.discountType,
      value: body.value,
      startsAt: body.startsAt,
      endsAt: body.endsAt,
      minQty: body.minQty,
      maxQty: body.maxQty,
    });

    if (!v.ok) return res.status(400).json({ success: false, message: v.message });

    const name = safeString(body.name) || "Seller Discount";
    const code = safeString(body.code);
    const now = new Date();

    const createdBy = {
      id: sellerId,
      role: "seller",
      email: safeString(req.user?.email) || null,
      name:
        safeString(req.user?.storeName) ||
        safeString(req.user?.shopName) ||
        safeString(req.user?.name) ||
        safeString(req.user?.fullName) ||
        null,
    };

    const sellerSnapshot = await loadSellerSnapshot(sellerId, req);

    const doc = {
      authority: "seller",
      kind: "seller_discount",
      createdByRole: "seller",

      sellerId: String(sellerId),

      scope: v.parsed.scope,
      productId: v.parsed.productId || null,
      categoryId: v.parsed.categoryId || null,

      discountType: v.parsed.discountType,
      value: v.parsed.value,

      minQty: v.parsed.minQty,
      maxQty: v.parsed.maxQty,

      name,
      code: code || null,
      description: safeString(body.description) || null,

      startsAt: v.parsed.startsAt,
      endsAt: v.parsed.endsAt,

      isActive: true,
      disabled: false,
      disabledAt: null,
      disabledBy: null,

      deletedAt: null,
      deletedBy: null,

      createdBy,
      sellerSnapshot: sellerSnapshot || null,

      createdAt: now,
      updatedAt: now,
    };

    const result = await Discounts.insertOne(doc);

    res.status(201).json({
      success: true,
      item: { ...doc, _id: result.insertedId },
    });
  } catch (err) {
    if (String(err?.code) === "11000") {
      return res.status(400).json({
        success: false,
        message: "Conflicting active store discount already exists.",
      });
    }
    res.status(500).json({ success: false, message: "Failed to create discount" });
  }
});

// PUT /api/seller/discounts/:id
router.put("/:id", sellerGuard, async (req, res) => {
  try {
    if (!ensureSeller(req, res)) return;

    const sellerId = getAuthedSellerId(req);
    if (!sellerId) {
      return res.status(401).json({
        success: false,
        message: "Auth error: missing seller id in token/session",
      });
    }

    const id = toObjectId(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: "Invalid discount id" });

    const existing = await Discounts.findOne({
      _id: id,
      sellerId: String(sellerId),
      $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
    });

    if (!existing) return res.status(404).json({ success: false, message: "Discount not found" });

    if (existing.disabled === true) {
      return res.status(403).json({
        success: false,
        message: "This discount is disabled by admin and cannot be edited.",
      });
    }

    const body = req.body || {};
    const v = await validateSellerDiscountPayload({
      sellerId,
      scope: body.scope ?? existing.scope,
      target:
        body.target || {
          productId: body.productId ?? existing.productId,
          categoryId: body.categoryId ?? existing.categoryId,
        },
      discountType: body.discountType ?? existing.discountType,
      value: body.value ?? existing.value,
      startsAt: hasStartsAt ? body.startsAt : existing.startsAt,
      endsAt: hasEndsAt ? body.endsAt : existing.endsAt,
      minQty: hasMinQty ? body.minQty : existing.minQty,
      maxQty: hasMaxQty ? body.maxQty : existing.maxQty,
      excludeId: String(id),
    });

    if (!v.ok) return res.status(400).json({ success: false, message: v.message });

    // ✅ NEW: repair snapshot if existing doc is missing/weak snapshot
    const repairedSnapshot = await ensureSnapshotForDiscount(existing, req, String(sellerId));

    const update = {
      $set: {
        sellerId: String(sellerId), // ✅ keep canonical
        scope: v.parsed.scope,
        productId: v.parsed.productId || null,
        categoryId: v.parsed.categoryId || null,
        discountType: v.parsed.discountType,
        value: v.parsed.value,
        minQty: v.parsed.minQty,
        maxQty: v.parsed.maxQty,
        startsAt: v.parsed.startsAt,
        endsAt: v.parsed.endsAt,

        name: safeString(body.name) || existing.name,
        code: safeString(body.code) || existing.code || null,
        description: safeString(body.description) || existing.description || null,

        updatedAt: new Date(),
      },
    };

    if (repairedSnapshot) {
      update.$set.sellerSnapshot = repairedSnapshot;
    }

    const updated = await Discounts.findOneAndUpdate(
      { _id: id, sellerId: String(sellerId) },
      update,
      { returnDocument: "after" }
    );

    res.json({ success: true, item: updated.value });
  } catch (err) {
    if (String(err?.code) === "11000") {
      return res.status(400).json({
        success: false,
        message: "Conflicting active store discount already exists.",
      });
    }
    res.status(500).json({ success: false, message: "Failed to update discount" });
  }
});

// PATCH /api/seller/discounts/:id/active
router.patch("/:id/active", sellerGuard, async (req, res) => {
  try {
    if (!ensureSeller(req, res)) return;

    const sellerId = getAuthedSellerId(req);
    if (!sellerId) {
      return res.status(401).json({
        success: false,
        message: "Auth error: missing seller id in token/session",
      });
    }

    const id = toObjectId(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: "Invalid discount id" });

    const isActive = typeof req.body?.isActive === "boolean" ? req.body.isActive : null;
    if (isActive === null) {
      return res.status(400).json({ success: false, message: "isActive must be boolean" });
    }

    const existing = await Discounts.findOne({
      _id: id,
      sellerId: String(sellerId),
      $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
    });

    if (!existing) return res.status(404).json({ success: false, message: "Discount not found" });

    if (existing.disabled === true) {
      return res.status(403).json({
        success: false,
        message: "This discount is disabled by admin and cannot be enabled.",
      });
    }

    if (isActive) {
      const v = await validateSellerDiscountPayload({
        sellerId,
        scope: existing.scope,
        target: { productId: existing.productId, categoryId: existing.categoryId },
        discountType: existing.discountType,
        value: existing.value,
        startsAt: existing.startsAt,
        endsAt: existing.endsAt,
        minQty: existing.minQty,
        maxQty: existing.maxQty,
        excludeId: String(id),
      });
      if (!v.ok) return res.status(400).json({ success: false, message: v.message });
    }

    // ✅ NEW: repair snapshot if missing/weak
    const repairedSnapshot = await ensureSnapshotForDiscount(existing, req, String(sellerId));

    const $set = { isActive, updatedAt: new Date(), sellerId: String(sellerId) };
    if (repairedSnapshot) $set.sellerSnapshot = repairedSnapshot;

    const updated = await Discounts.findOneAndUpdate(
      { _id: id, sellerId: String(sellerId) },
      { $set },
      { returnDocument: "after" }
    );

    res.json({ success: true, item: updated.value });
  } catch (err) {
    if (String(err?.code) === "11000") {
      return res.status(400).json({
        success: false,
        message: "Conflicting active store discount already exists.",
      });
    }
    res.status(500).json({ success: false, message: "Failed to update active flag" });
  }
});

// DELETE /api/seller/discounts/:id
router.delete("/:id", sellerGuard, async (req, res) => {
  try {
    if (!ensureSeller(req, res)) return;

    const sellerId = getAuthedSellerId(req);
    if (!sellerId) {
      return res.status(401).json({
        success: false,
        message: "Auth error: missing seller id in token/session",
      });
    }

    const id = toObjectId(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: "Invalid discount id" });

    const existing = await Discounts.findOne({
      _id: id,
      sellerId: String(sellerId),
      $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
    });

    if (!existing) return res.status(404).json({ success: false, message: "Discount not found" });

    // ✅ NEW: repair snapshot even on delete (useful for audits/admin views)
    const repairedSnapshot = await ensureSnapshotForDiscount(existing, req, String(sellerId));

    const $set = {
      deletedAt: new Date(),
      deletedBy: { id: String(sellerId), role: "seller" },
      isActive: false,
      updatedAt: new Date(),
      sellerId: String(sellerId),
    };
    if (repairedSnapshot) $set.sellerSnapshot = repairedSnapshot;

    const updated = await Discounts.findOneAndUpdate(
      { _id: id, sellerId: String(sellerId) },
      { $set },
      { returnDocument: "after" }
    );

    res.json({ success: true, item: updated.value });
  } catch {
    res.status(500).json({ success: false, message: "Failed to delete discount" });
  }
});

export default router;
