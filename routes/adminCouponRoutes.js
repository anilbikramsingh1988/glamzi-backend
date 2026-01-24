// routes/adminCouponRoutes.js  (UNIFIED DISCOUNT SCHEMA)
// Admin coupons create/list/status using the same schema that:
// - applyDiscounts() expects
// - reserveAdminCouponOrNull() enforces atomically at order create
//
// IMPORTANT (once):
// db.discounts.createIndex({ authority: 1, codeType: 1, code: 1 }, { unique: true })
// db.discountAuditLogs.createIndex({ discountId: 1, createdAt: -1 })
// db.couponRedemptions.createIndex({ discountId: 1, userId: 1 }, { unique: true })  // for perUserLimit atomic enforcement

import express from "express";
import { ObjectId } from "mongodb";
import { client } from "../dbConfig.js";
import { authMiddleware } from "../middlewares/authMiddleware.js";

const router = express.Router();
const dbName = process.env.DB_NAME || "glamzi_ecommerce";
const db = client.db(dbName);

const Discounts = db.collection("discounts");
const Audit = db.collection("discountAuditLogs");

/* ===============================
   HELPERS
=============================== */
const nowUtc = () => new Date();

function ensureAdmin(req, res) {
  const role = String(req.user?.role || "").toLowerCase();
  // ✅ Recommended: coupon management should be admin/super-admin/marketing.
  // If you truly want staff here, add "staff" back explicitly.
  if (!["admin", "super-admin", "marketing"].includes(role)) {
    res.status(403).json({ success: false, message: "Admin access only" });
    return false;
  }
  return true;
}

function safeStr(v) {
  return String(v ?? "").trim();
}

function escapeRegex(input = "") {
  return String(input).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeStatus(s) {
  // unified statuses we use for discounts
  const v = String(s || "").trim().toLowerCase();
  // Keep "paused" for UI compatibility if you use it; reservation logic will treat it as inactive.
  if (["draft", "active", "inactive", "disabled", "paused", "expired"].includes(v)) return v;
  return null;
}

function clampNumber(n, min, max) {
  const x = Number(n);
  if (!Number.isFinite(x)) return null;
  return Math.min(max, Math.max(min, x));
}

function clampInt(n, min, max) {
  const x = Math.floor(Number(n));
  if (!Number.isFinite(x)) return null;
  return Math.min(max, Math.max(min, x));
}

function parseDateMaybe(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function normalizeCouponCode(code) {
  const c = safeStr(code).toUpperCase().replace(/\s+/g, "");
  if (!/^[A-Z0-9_-]{3,30}$/.test(c)) return "";
  return c;
}

/**
 * ✅ IMPORTANT: Engine expects kind: "percentage" | "flat" | "free_shipping"
 * Your UI may send "fixed" — normalize to "flat".
 */
function normalizeKind(discountType) {
  const t = safeStr(discountType).toLowerCase();

  if (t === "percentage") return "percentage";
  if (t === "flat") return "flat";
  if (t === "fixed") return "flat"; // ✅ schema alignment
  if (t === "free_shipping" || t === "free-shipping") return "free_shipping";

  return null;
}

async function audit(discountId, action, actor, meta = {}) {
  try {
    await Audit.insertOne({
      discountId: String(discountId),
      action,
      actor,
      meta,
      createdAt: nowUtc(),
    });
  } catch {
    // non-blocking
  }
}

/* ===============================
   ROUTES (ADMIN COUPONS)
   Base mount recommended: app.use("/api/admin", adminCouponRoutes)
=============================== */

/**
 * GET /api/admin/coupons
 * Query: status, q, limit, page
 * - q matches code partial (case-insensitive)
 */
router.get("/coupons", authMiddleware, async (req, res) => {
  if (!ensureAdmin(req, res)) return;

  const status = normalizeStatus(req.query.status);
  const q = safeStr(req.query.q);

  const limitRaw = Number(req.query.limit ?? 50);
  const pageRaw = Number(req.query.page ?? 1);

  const limit = Math.min(200, Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 50));
  const page = Math.max(1, Number.isFinite(pageRaw) ? pageRaw : 1);
  const skip = (page - 1) * limit;

  const filter = {
    authority: "admin",
    codeType: "coupon",
    $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
  };

  if (status) {
    if (status === "paused") filter.status = { $in: ["paused", "inactive"] };
    else filter.status = status;
  }

  if (q) {
    const rx = new RegExp(escapeRegex(q), "i");
    filter.code = rx;
  }

  try {
    const [items, total] = await Promise.all([
      Discounts.find(filter)
        .sort({ updatedAt: -1, _id: -1 })
        .skip(skip)
        .limit(limit)
        .toArray(),
      Discounts.countDocuments(filter),
    ]);

    res.json({
      success: true,
      items,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 },
    });
  } catch (err) {
    console.error("GET /api/admin/coupons error:", err);
    res.status(500).json({ success: false, message: "Failed to load coupons" });
  }
});

/**
 * POST /api/admin/coupons
 * body: {
 *   code,
 *   discountType: "percentage" | "fixed" | "flat" | "free_shipping",
 *   value,                // ignored for free_shipping
 *   minCartValue,         // maps to minCartSubtotal
 *   maxUses,              // maps to usageLimitTotal
 *   perUserLimit,
 *   maxDiscount,
 *   startAt,
 *   endAt,
 *   status
 * }
 */
router.post("/coupons", authMiddleware, async (req, res) => {
  if (!ensureAdmin(req, res)) return;

  const actorId = safeStr(req.user?.id || req.user?._id || req.user?.email);
  const role = String(req.user?.role || "admin").toLowerCase();

  const code = normalizeCouponCode(req.body?.code);
  if (!code) return res.status(400).json({ success: false, message: "Coupon code required" });

  const kind = normalizeKind(req.body?.discountType);
  if (!kind) return res.status(400).json({ success: false, message: "Invalid discountType" });

  // Value rules:
  // - percentage: 1..80
  // - flat: 1..999999999
  // - free_shipping: value forced to 0
  const value =
    kind === "free_shipping"
      ? 0
      : kind === "percentage"
        ? clampInt(req.body?.value, 1, 80)
        : clampInt(req.body?.value, 1, 999999999);

  if (value == null) return res.status(400).json({ success: false, message: "Invalid value" });

  const minCartSubtotal = clampNumber(req.body?.minCartValue ?? 0, 0, 999999999);
  if (minCartSubtotal == null) {
    return res.status(400).json({ success: false, message: "Invalid minCartValue" });
  }

  const usageLimitTotal =
    req.body?.maxUses == null || req.body?.maxUses === ""
      ? null
      : clampInt(req.body.maxUses, 1, 999999999);

  const perUserLimit =
    req.body?.perUserLimit == null || req.body?.perUserLimit === ""
      ? null
      : clampInt(req.body.perUserLimit, 1, 999999999);

  const maxDiscount =
    kind !== "percentage"
      ? null // typically only meaningful for percentage; keep schema clean
      : req.body?.maxDiscount == null || req.body?.maxDiscount === ""
        ? null
        : clampNumber(req.body.maxDiscount, 0, 999999999);

  const startAt = parseDateMaybe(req.body?.startAt);
  const endAt = parseDateMaybe(req.body?.endAt);

  if (startAt && endAt && endAt < startAt) {
    return res.status(400).json({ success: false, message: "endAt must be after startAt" });
  }

  const status = normalizeStatus(req.body?.status) || "draft";
  const isActive = status === "active";

  const now = nowUtc();
  if (isActive) {
    if (endAt && endAt < now) {
      return res.status(400).json({ success: false, message: "Cannot activate an expired coupon" });
    }
    if (startAt && startAt > now) {
      return res
        .status(400)
        .json({ success: false, message: "Cannot activate coupon before its start date" });
    }
  }

  const doc = {
    // Unified identifiers
    authority: "admin",
    codeType: "coupon",
    code,

    // Pricing rule (✅ engine-aligned)
    kind, // "percentage" | "flat" | "free_shipping"
    value,
    maxDiscount,
    minCartSubtotal,

    // Usage
    usageLimitTotal: usageLimitTotal == null ? null : usageLimitTotal,
    perUserLimit: perUserLimit == null ? null : perUserLimit,
    usedCount: 0,

    // Lifecycle
    status, // draft/active/inactive/disabled/paused/expired
    isActive, // redundant but used by legacy checks
    startAt: startAt || null,
    endAt: endAt || null,

    // Optional flags
    stackableWithFreeShipping: true,

    // Audit/meta
    createdBy: { userId: actorId, role },
    updatedBy: { userId: actorId, role },
    createdAt: nowUtc(),
    updatedAt: nowUtc(),
  };

  try {
    const r = await Discounts.insertOne(doc);

    await audit(r.insertedId, "created", { userId: actorId, role }, { code, codeType: "coupon" });

    res.status(201).json({ success: true, item: { ...doc, _id: r.insertedId } });
  } catch (e) {
    console.error("POST /api/admin/coupons error:", e);
    res.status(400).json({
      success: false,
      message: "Failed to create coupon (code may already exist)",
    });
  }
});

/**
 * PATCH /api/admin/coupons/:id/status
 * body: { status }
 */
router.patch("/coupons/:id/status", authMiddleware, async (req, res) => {
  if (!ensureAdmin(req, res)) return;

  const actorId = safeStr(req.user?.id || req.user?._id || req.user?.email);
  const role = String(req.user?.role || "admin").toLowerCase();

  const idStr = safeStr(req.params.id);
  if (!ObjectId.isValid(idStr)) {
    return res.status(400).json({ success: false, message: "Invalid id" });
  }
  const id = new ObjectId(idStr);

  const status = normalizeStatus(req.body?.status);
  if (!status) return res.status(400).json({ success: false, message: "Invalid status" });

  try {
    const existing = await Discounts.findOne({
      _id: id,
      authority: "admin",
      codeType: "coupon",
    });

    if (!existing) {
      return res.status(404).json({ success: false, message: "Coupon not found" });
    }

    const now = nowUtc();

    if (status === "active") {
      const startAt = existing.startAt ? new Date(existing.startAt) : null;
      const endAt = existing.endAt ? new Date(existing.endAt) : null;
      if (endAt && endAt < now) {
        return res
          .status(400)
          .json({ success: false, message: "Cannot activate an expired coupon" });
      }
      if (startAt && startAt > now) {
        return res
          .status(400)
          .json({ success: false, message: "Cannot activate coupon before its start date" });
      }
    }

    const setObj = {
      status,
      isActive: status === "active",
      updatedAt: now,
      updatedBy: { userId: actorId, role },
    };

    if (status === "disabled") {
      setObj.disabledAt = now;
    }

    const update = { $set: setObj };

    if (status !== "disabled") {
      update.$unset = { disabledAt: "" };
    }

    const r = await Discounts.findOneAndUpdate(
      { _id: id, authority: "admin", codeType: "coupon" },
      update,
      { returnDocument: "after" }
    );

    await audit(id, "status_changed", { userId: actorId, role }, { status });

    res.json({ success: true, item: r.value });
  } catch (err) {
    console.error("PATCH /api/admin/coupons/:id/status error:", err);
    res.status(500).json({ success: false, message: "Failed to update status" });
  }
});

export default router;
