// routes/adminDiscountRoutes.js (MERGED: admin campaigns + seller moderation)

import express from "express";
import { ObjectId } from "mongodb";
import dotenv from "dotenv";

import { client } from "../dbConfig.js";
import {
  authMiddleware,
  isActiveMiddleware,
  isStaffMiddleware,
} from "../middlewares/authMiddleware.js";

dotenv.config();
const router = express.Router();

const dbName = process.env.DB_NAME || "glamzi_ecommerce";
const db = client.db(dbName);

const Discounts = db.collection("discounts");
const Users = db.collection("users"); // ✅ NEW: for seller enrichment (lookup)

// Staff guard (admin/staff)
const staffGuard = [authMiddleware, isActiveMiddleware, isStaffMiddleware];

// Only allow these roles for discount module
function ensureDiscountRole(req, res) {
  const role = String(req.user?.role || "").toLowerCase();
  const allowed = ["super-admin", "admin", "marketing"];
  if (!allowed.includes(role)) {
    res.status(403).json({ success: false, message: "Discount access only" });
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

function escapeRegex(input = "") {
  return String(input || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function safeInt(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function safeNumber(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function safeString(v, max = 300) {
  const s = typeof v === "string" ? v.trim() : "";
  return s.length > max ? s.slice(0, max) : s;
}

function normalizeAdminStatus(s) {
  const v = String(s || "").toLowerCase();
  return ["draft", "active", "paused", "inactive", "disabled", "expired"].includes(v)
    ? v
    : "draft";
}

function normalizeAdminKind(k) {
  const v = String(k || "").toLowerCase();
  return ["percentage", "flat", "free_shipping"].includes(v) ? v : "percentage";
}

function normalizeFlashKind(k) {
  const v = String(k || "").toLowerCase();
  if (v === "fixed_price" || v === "fixed-price") return "flat";
  if (v === "percentage") return "percentage";
  return normalizeAdminKind(v);
}

function parseDateOrNull(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function normalizeScope(scope) {
  const s = String(scope || "").toLowerCase();
  if (["product", "category", "store"].includes(s)) return s;
  return "";
}

/* ===============================
   MATCH BUILDERS
=============================== */

// Admin campaigns match: authority="admin" OR createdByRole="admin" OR codeType in (campaign,coupon)
function buildAdminDiscountMatch({ status, q }) {
  const match = {
    $and: [
      {
        $or: [
          { authority: "admin" },
          { createdByRole: "admin" },
          { codeType: { $in: ["campaign", "coupon"] } },
        ],
      },
    ],
  };

  const st = String(status || "").toLowerCase().trim();
  if (st) match.$and.push({ status: st });

  if (q) {
    const rx = new RegExp(escapeRegex(q), "i");
    match.$and.push({
      $or: [
        { title: rx },
        { name: rx },
        { code: rx },
        { description: rx },
        { codeType: rx },
        { kind: rx },
      ],
    });
  }

  return match.$and.length ? match : {};
}

// Seller discounts moderation match
function buildSellerDiscountMatch({ sellerId, scope, status, q, from, to }) {
  const match = {
    $and: [
      {
        $or: [
          { authority: "seller" },
          { createdByRole: "seller" },
          { kind: "seller_discount" },
        ],
      },
    ],
  };

  // ✅ IMPROVED: sellerId filter supports string OR ObjectId in legacy docs
  if (sellerId) {
    const sid = String(sellerId).trim();
    const oid = ObjectId.isValid(sid) ? new ObjectId(sid) : null;

    match.$and.push({
      $or: [
        { sellerId: sid },
        { ownerSellerId: sid },
        ...(oid
          ? [
              { sellerId: oid },
              { ownerSellerId: oid },
            ]
          : []),
      ],
    });
  }

  const ns = normalizeScope(scope);
  if (ns) match.$and.push({ scope: ns });

  // status: disabled | active | upcoming | expired | all
  const now = new Date();
  const st = String(status || "").toLowerCase().trim();

  if (st === "disabled") {
    match.$and.push({ disabled: true });
  } else if (st === "active") {
    match.$and.push({
      $or: [{ disabled: { $ne: true } }, { disabled: { $exists: false } }],
    });
    match.$and.push({
      $or: [
        { startsAt: null },
        { startsAt: { $exists: false } },
        { startsAt: { $lte: now } },
      ],
    });
    match.$and.push({
      $or: [
        { endsAt: null },
        { endsAt: { $exists: false } },
        { endsAt: { $gte: now } },
      ],
    });
  } else if (st === "upcoming") {
    match.$and.push({ startsAt: { $gt: now } });
  } else if (st === "expired") {
    match.$and.push({ endsAt: { $lt: now } });
  }

  if (q) {
    const rx = new RegExp(escapeRegex(q), "i");
    match.$and.push({
      $or: [
        { sellerId: rx },
        { ownerSellerId: rx },
        { "sellerSnapshot.storeName": rx }, // ✅ IMPORTANT: search snapshot too
        { sellerStoreName: rx },
        { title: rx },
        { name: rx },
        { code: rx },
        { description: rx },
      ],
    });
  }

  const fromDate = from ? new Date(from) : null;
  const toDate = to ? new Date(to) : null;

  const createdAt = {};
  if (fromDate && !Number.isNaN(fromDate.getTime())) createdAt.$gte = fromDate;
  if (toDate && !Number.isNaN(toDate.getTime())) createdAt.$lte = toDate;

  if (Object.keys(createdAt).length) match.$and.push({ createdAt });

  return match.$and.length ? match : {};
}

/* ===================================================
   ADMIN CAMPAIGNS (AdminDiscounts.jsx)
   Base: /api/admin/discounts
=================================================== */

// GET /api/admin/discounts
router.get("/", staffGuard, async (req, res) => {
  try {
    if (!ensureDiscountRole(req, res)) return;

    const status = req.query.status ? String(req.query.status) : "";
    const q = req.query.q ? String(req.query.q) : "";

    const match = buildAdminDiscountMatch({ status, q });

    const pipeline = [
      { $match: match },
      {
        $project: {
          _id: 1,
          authority: 1,
          createdByRole: 1,
          codeType: 1,

          title: { $ifNull: ["$title", "$name"] },
          name: { $ifNull: ["$name", "$title"] },

          kind: 1, // percentage | flat | free_shipping
          value: 1,
          maxDiscount: 1,
          minCartSubtotal: 1,

          scope: 1,
          status: 1,
          isActive: 1,
          priority: 1,
          stackableWithFreeShipping: 1,

          startAt: 1,
          endAt: 1,

          createdAt: 1,
          updatedAt: 1,
        },
      },
      { $sort: { createdAt: -1, _id: -1 } },
    ];

    const items = await Discounts.aggregate(pipeline).toArray();

    res.json({ success: true, items });
  } catch (err) {
    console.error("GET /api/admin/discounts error:", err);
    res.status(500).json({ success: false, message: "Failed to load discounts" });
  }
});

// POST /api/admin/discounts
router.post("/", staffGuard, async (req, res) => {
  try {
    if (!ensureDiscountRole(req, res)) return;

    const title = safeString(req.body?.title, 200);
    if (!title) {
      return res.status(400).json({ success: false, message: "Title is required" });
    }

    const saleType = String(req.body?.saleType || "").toLowerCase();
    const kind =
      saleType === "flash"
        ? normalizeFlashKind(req.body?.pricing?.type || req.body?.kind)
        : normalizeAdminKind(req.body?.kind);
    const status = normalizeAdminStatus(req.body?.status);

    const minCartSubtotal = safeNumber(req.body?.minCartSubtotal, 0);
    const priority = safeInt(req.body?.priority, 0);

    const rawValue =
      saleType === "flash"
        ? req.body?.pricing?.value
        : req.body?.value !== undefined
          ? req.body?.value
          : req.body?.pricing?.value;
    const value = kind === "free_shipping" ? 0 : safeNumber(rawValue, 0);
    if (kind !== "free_shipping" && (!Number.isFinite(value) || value <= 0)) {
      return res.status(400).json({ success: false, message: "Value must be > 0" });
    }

    const maxDiscount =
      kind === "percentage" &&
      req.body?.maxDiscount !== null &&
      req.body?.maxDiscount !== undefined &&
      req.body?.maxDiscount !== ""
        ? safeNumber(req.body.maxDiscount, 0)
        : null;

    const startAt =
      parseDateOrNull(req.body?.startAt) ||
      parseDateOrNull(req.body?.window?.startAt);
    const endAt =
      parseDateOrNull(req.body?.endAt) ||
      parseDateOrNull(req.body?.window?.endAt);

    if (startAt && endAt && startAt > endAt) {
      return res.status(400).json({ success: false, message: "startAt must be <= endAt" });
    }

    const scopeRaw = String(req.body?.scope || "").toLowerCase();
    const scope =
      saleType === "flash"
        ? "product"
        : kind === "free_shipping"
          ? "shipping"
          : scopeRaw || "cart";

    const productIds =
      saleType === "flash" && Array.isArray(req.body?.productIds)
        ? req.body.productIds
            .map((id) => toObjectId(id) || id)
            .filter(Boolean)
        : undefined;

    const limits =
      saleType === "flash"
        ? {
            totalQty: safeInt(req.body?.limits?.totalQty, 0),
            perUserQty: safeInt(req.body?.limits?.perUserQty, 0),
            perOrderQty: safeInt(req.body?.limits?.perOrderQty, 0),
          }
        : undefined;

    const doc = {
      authority: "admin",
      createdByRole: "admin",
      codeType: "campaign", // keep existing codeType for admin-created
      title,

      kind,
      value,
      maxDiscount,
      minCartSubtotal,

      scope,
      status,
      isActive: status === "active",

      priority,
      stackableWithFreeShipping: !!req.body?.stackableWithFreeShipping,

      startAt: startAt || null,
      endAt: endAt || null,

      ...(saleType ? { saleType } : {}),
      ...(productIds ? { productIds } : {}),
      ...(limits ? { limits } : {}),
      ...(saleType === "flash"
        ? {
            pricing: {
              type: req.body?.pricing?.type || kind,
              value,
            },
          }
        : {}),

      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const ins = await Discounts.insertOne(doc);

    res.json({ success: true, item: { ...doc, _id: ins.insertedId } });
  } catch (err) {
    console.error("POST /api/admin/discounts error:", err);
    res.status(500).json({ success: false, message: "Failed to create discount" });
  }
});

// PATCH /api/admin/discounts/:id/status
// Body: { status: "active" | "draft" | "paused" | "inactive" | "disabled" | "expired" }
router.patch("/:id/status", staffGuard, async (req, res) => {
  try {
    if (!ensureDiscountRole(req, res)) return;

    const id = toObjectId(req.params.id);
    if (!id) {
      return res.status(400).json({ success: false, message: "Invalid discount id" });
    }

    const nextStatus = normalizeAdminStatus(req.body?.status);

    const existing = await Discounts.findOne({ _id: id });
    if (!existing) {
      return res.status(404).json({ success: false, message: "Discount not found" });
    }

    const isAdminDiscount =
      existing?.authority === "admin" ||
      existing?.createdByRole === "admin" ||
      ["campaign", "coupon"].includes(String(existing?.codeType || ""));

    if (!isAdminDiscount) {
      return res.status(400).json({ success: false, message: "Not an admin discount" });
    }

    const result = await Discounts.findOneAndUpdate(
      { _id: id },
      {
        $set: {
          status: nextStatus,
          isActive: nextStatus === "active",
          updatedAt: new Date(),
        },
      },
      { returnDocument: "after" }
    );

    res.json({ success: true, item: result.value });
  } catch (err) {
    console.error("PATCH /api/admin/discounts/:id/status error:", err);
    res.status(500).json({ success: false, message: "Failed to update status" });
  }
});

// DELETE /api/admin/discounts/:id
router.delete("/:id", staffGuard, async (req, res) => {
  try {
    if (!ensureDiscountRole(req, res)) return;

    const id = toObjectId(req.params.id);
    if (!id) {
      return res.status(400).json({ success: false, message: "Invalid discount id" });
    }

    const existing = await Discounts.findOne({ _id: id });
    if (!existing) {
      return res.status(404).json({ success: false, message: "Discount not found" });
    }

    const isAdminDiscount =
      existing?.authority === "admin" ||
      existing?.createdByRole === "admin" ||
      String(existing?.saleType || "").toLowerCase() === "flash" ||
      ["campaign", "coupon"].includes(String(existing?.codeType || ""));

    if (!isAdminDiscount) {
      return res.status(400).json({ success: false, message: "Not an admin discount" });
    }

    const result = await Discounts.deleteOne({ _id: id });
    res.json({ success: true, deleted: result.deletedCount || 0 });
  } catch (err) {
    console.error("DELETE /api/admin/discounts/:id error:", err);
    res.status(500).json({ success: false, message: "Failed to delete discount" });
  }
});

/* ===================================================
   SELLER DISCOUNT MODERATION (ADMIN)
   Base: /api/admin/discounts
=================================================== */

// GET /api/admin/discounts/sellers
router.get("/sellers", staffGuard, async (req, res) => {
  try {
    if (!ensureDiscountRole(req, res)) return;

    const page = Math.max(1, safeInt(req.query.page, 1));
    const limit = Math.min(100, Math.max(5, safeInt(req.query.limit, 20)));
    const skip = (page - 1) * limit;

    const sellerId = req.query.sellerId ? String(req.query.sellerId) : "";
    const scope = req.query.scope ? String(req.query.scope) : "";
    const status = req.query.status ? String(req.query.status) : "";
    const q = req.query.q ? String(req.query.q) : "";
    const from = req.query.from ? String(req.query.from) : "";
    const to = req.query.to ? String(req.query.to) : "";

    const match = buildSellerDiscountMatch({ sellerId, scope, status, q, from, to });

    const pipeline = [
      { $match: match },

      // ✅ NEW: derive a robust seller id string for enrichment + UI
      {
        $addFields: {
          __sid: {
            $let: {
              vars: {
                s1: {
                  $cond: [
                    {
                      $and: [
                        { $ne: ["$sellerId", null] },
                        { $ne: ["$sellerId", ""] },
                      ],
                    },
                    "$sellerId",
                    null,
                  ],
                },
              },
              in: {
                $ifNull: [
                  "$$s1",
                  { $ifNull: ["$ownerSellerId", { $ifNull: ["$createdBy.id", "$sellerSnapshot.id"] }] },
                ],
              },
            },
          },
        },
      },
      { $addFields: { __sidStr: { $trim: { input: { $toString: "$__sid" } } } } },

      // ✅ NEW: lookup seller from users (only used as fallback if sellerSnapshot missing/weak)
      {
        $lookup: {
          from: "users",
          let: { sid: "$__sidStr" },
          pipeline: [
            {
              $match: {
                $expr: {
                  $or: [
                    { $eq: [{ $toString: "$_id" }, "$$sid"] },
                    { $eq: ["$sellerId", "$$sid"] },
                  ],
                },
              },
            },
            {
              $project: {
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
              },
            },
          ],
          as: "__sellerUser",
        },
      },
      { $addFields: { __sellerUser: { $first: "$__sellerUser" } } },

      // ✅ NEW: ensure sellerSnapshot is always present in response (snapshot-first, fallback to user lookup)
      {
        $addFields: {
          sellerSnapshot: {
            $cond: [
              {
                $and: [
                  { $ne: ["$sellerSnapshot", null] },
                  { $ne: ["$sellerSnapshot.id", null] },
                  { $ne: ["$sellerSnapshot.id", ""] },
                  {
                    $or: [
                      { $gt: [{ $strLenCP: { $ifNull: ["$sellerSnapshot.storeName", ""] } }, 0] },
                      { $gt: [{ $strLenCP: { $ifNull: ["$sellerSnapshot.email", ""] } }, 0] },
                    ],
                  },
                ],
              },
              "$sellerSnapshot",
              {
                id: "$__sidStr",
                storeName: {
                  $ifNull: [
                    "$__sellerUser.storeName",
                    {
                      $ifNull: [
                        "$__sellerUser.shopName",
                        {
                          $ifNull: [
                            "$__sellerUser.businessName",
                            { $ifNull: ["$__sellerUser.name", "$__sellerUser.fullName"] },
                          ],
                        },
                      ],
                    },
                  ],
                },
                shopName: "$__sellerUser.shopName",
                email: "$__sellerUser.email",
                phone: { $ifNull: ["$__sellerUser.phone", "$__sellerUser.mobile"] },
                avatar: {
                  $ifNull: [
                    "$__sellerUser.avatar",
                    {
                      $ifNull: [
                        "$__sellerUser.storeLogo",
                        {
                          $ifNull: [
                            "$__sellerUser.logo",
                            { $ifNull: ["$__sellerUser.profileImage", "$__sellerUser.image"] },
                          ],
                        },
                      ],
                    },
                  ],
                },
                isVerified: {
                  $cond: [
                    { $eq: [{ $type: "$__sellerUser.isVerified" }, "bool"] },
                    "$__sellerUser.isVerified",
                    { $cond: [{ $eq: ["$__sellerUser.verified", true] }, true, false] },
                  ],
                },
                isActive: "$__sellerUser.isActive",
              },
            ],
          },
        },
      },

      // ✅ FIX: project sellerSnapshot so UI can show seller name/logo/verified
      {
        $project: {
          _id: 1,
          authority: 1,
          kind: 1,

          sellerId: { $ifNull: ["$sellerId", "$ownerSellerId"] },
          sellerStoreName: 1,
          sellerSnapshot: 1, // ✅ ADDED
          createdBy: 1,       // ✅ ADDED (useful fallback in UI)

          scope: 1,
          productId: 1,
          categoryId: 1,

          title: { $ifNull: ["$title", "$name"] },
          name: { $ifNull: ["$name", "$title"] },
          code: 1,

          discountType: 1,
          value: 1,

          startsAt: 1,
          endsAt: 1,

          disabled: { $ifNull: ["$disabled", false] },
          disabledAt: 1,
          disabledBy: 1,
          disabledNote: 1,

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
    console.error("GET /api/admin/discounts/sellers error:", err);
    res.status(500).json({ success: false, message: "Failed to list seller discounts" });
  }
});

// PATCH /api/admin/discounts/sellers/:id/status
// Body: { enabled: true|false, note?: string }
router.patch("/sellers/:id/status", staffGuard, async (req, res) => {
  try {
    if (!ensureDiscountRole(req, res)) return;

    const id = toObjectId(req.params.id);
    if (!id) {
      return res.status(400).json({ success: false, message: "Invalid discount id" });
    }

    const enabled = typeof req.body?.enabled === "boolean" ? req.body.enabled : null;
    if (enabled === null) {
      return res.status(400).json({ success: false, message: "enabled must be boolean" });
    }

    const note = req.body?.note ? String(req.body.note).trim().slice(0, 500) : "";

    const existing = await Discounts.findOne({ _id: id });
    if (!existing) {
      return res.status(404).json({ success: false, message: "Discount not found" });
    }

    const isSellerDiscount =
      existing?.authority === "seller" ||
      existing?.createdByRole === "seller" ||
      existing?.kind === "seller_discount";

    if (!isSellerDiscount) {
      return res.status(400).json({ success: false, message: "Not a seller discount" });
    }

    const adminActor = {
      id: String(req.user?._id || ""),
      role: String(req.user?.role || ""),
      email: req.user?.email ? String(req.user.email) : undefined,
      name: req.user?.name ? String(req.user.name) : undefined,
    };

    const update = {
      $set: {
        disabled: !enabled,
        updatedAt: new Date(),
        disabledAt: !enabled ? new Date() : null,
        disabledBy: !enabled ? adminActor : null,
        disabledNote: note ? note : null,
        status: enabled ? "approved" : "rejected",
      },
    };

    const result = await Discounts.findOneAndUpdate({ _id: id }, update, {
      returnDocument: "after",
    });

    res.json({ success: true, item: result.value });
  } catch (err) {
    console.error("PATCH /api/admin/discounts/sellers/:id/status error:", err);
    res.status(500).json({ success: false, message: "Failed to update seller discount status" });
  }
});

export default router;
