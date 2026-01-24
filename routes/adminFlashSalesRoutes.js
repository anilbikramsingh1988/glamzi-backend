// routes/adminFlashSalesRoutes.js
// Dedicated admin flash-sale surface (product-scoped, time-boxed, quantity capped)
// All docs still live in the unified "discounts" collection with saleType: "flash".

import express from "express";
import dotenv from "dotenv";
import { ObjectId } from "mongodb";

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

// Guards
const staffGuard = [authMiddleware, isActiveMiddleware, isStaffMiddleware];
const ensureDiscountRole = (req, res) => {
  const role = String(req.user?.role || "").toLowerCase();
  const allowed = ["super-admin", "admin", "marketing"];
  if (!allowed.includes(role)) {
    res.status(403).json({ success: false, message: "Discount access only" });
    return false;
  }
  return true;
};

// Helpers
const toObjectId = (id) => {
  if (!id) return null;
  const s = String(id).trim();
  if (!ObjectId.isValid(s)) return null;
  try {
    return new ObjectId(s);
  } catch {
    return null;
  }
};

const safeInt = (v, d = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : d;
};

const safeNumber = (v, d = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

const safeString = (v, max = 300) => {
  const s = typeof v === "string" ? v.trim() : "";
  return s.length > max ? s.slice(0, max) : s;
};

const parseDateOrNull = (v) => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

const normalizeStatus = (s) => {
  const v = String(s || "").toLowerCase();
  return ["draft", "active", "paused", "inactive", "disabled", "expired"].includes(v)
    ? v
    : "draft";
};

const normalizePricingType = (t) => {
  const v = String(t || "").toLowerCase();
  if (v === "percentage" || v === "percent") return "percentage";
  if (v === "fixed_price" || v === "fixed-price" || v === "flat") return "fixed_price";
  return "";
};

const normalizeKindFromPricing = (pricingType) => {
  return pricingType === "percentage" ? "percentage" : "flat";
};

const buildProductIdMatch = (pid) => {
  if (!pid) return null;
  const s = String(pid).trim();
  const oid = toObjectId(s);
  const match = [s];
  if (oid) match.push(oid);
  return { productIds: { $in: match } };
};

/* ===============================
   GET /api/admin/flash-sales
   Query: status, q, productId, from, to
=============================== */
router.get("/", staffGuard, async (req, res) => {
  try {
    if (!ensureDiscountRole(req, res)) return;

    const status = String(req.query.status || "").toLowerCase();
    const q = String(req.query.q || "").trim();
    const productId = req.query.productId ? String(req.query.productId) : "";
    const from = parseDateOrNull(req.query.from);
    const to = parseDateOrNull(req.query.to);

    const match = {
      saleType: "flash",
      scope: "product",
    };

    if (status) match.status = status;
    if (q) {
      const rx = new RegExp(safeString(q), "i");
      match.$or = [{ title: rx }, { description: rx }];
    }
    const pidMatch = buildProductIdMatch(productId);
    if (pidMatch) Object.assign(match, pidMatch);

    if (from || to) {
      match.startAt = {};
      if (from) match.startAt.$gte = from;
      if (to) match.startAt.$lte = to;
    }

    const projection = {
      title: 1,
      productIds: 1,
      pricing: 1,
      limits: 1,
      window: 1,
      startAt: 1,
      endAt: 1,
      status: 1,
      scope: 1,
      saleType: 1,
      createdAt: 1,
      updatedAt: 1,
    };

    const items = await Discounts.find(match, { projection })
      .sort({ updatedAt: -1, createdAt: -1 })
      .limit(200)
      .toArray();

    res.json({ success: true, items });
  } catch (err) {
    console.error("GET /api/admin/flash-sales error:", err);
    res.status(500).json({ success: false, message: "Failed to load flash sales" });
  }
});

/* ===============================
   POST /api/admin/flash-sales
=============================== */
router.post("/", staffGuard, async (req, res) => {
  try {
    if (!ensureDiscountRole(req, res)) return;

    const title = safeString(req.body?.title || "Flash Sale");

    const rawProductIds = Array.isArray(req.body?.productIds) ? req.body.productIds : [];
    const productIds = rawProductIds
      .map((id) => toObjectId(id) || String(id).trim())
      .filter(Boolean);
    if (!productIds.length) {
      return res.status(400).json({ success: false, message: "productIds is required" });
    }

    const pricingType = normalizePricingType(req.body?.pricing?.type || req.body?.kind);
    const pricingValue = safeNumber(req.body?.pricing?.value ?? req.body?.value, NaN);
    if (!pricingType || !Number.isFinite(pricingValue) || pricingValue <= 0) {
      return res
        .status(400)
        .json({ success: false, message: "Valid pricing.type and pricing.value are required" });
    }

    const startAt =
      parseDateOrNull(req.body?.startAt) || parseDateOrNull(req.body?.window?.startAt);
    const endAt = parseDateOrNull(req.body?.endAt) || parseDateOrNull(req.body?.window?.endAt);
    if (!startAt || !endAt) {
      return res.status(400).json({ success: false, message: "startAt and endAt are required" });
    }
    if (startAt > endAt) {
      return res.status(400).json({ success: false, message: "startAt must be <= endAt" });
    }

    const limits = {
      totalQty: safeInt(req.body?.limits?.totalQty ?? req.body?.totalQty, 0),
      perUserQty: safeInt(req.body?.limits?.perUserQty ?? req.body?.perUserQty, 0),
      perOrderQty: safeInt(req.body?.limits?.perOrderQty ?? req.body?.perOrderQty, 0),
    };

    const status = normalizeStatus(req.body?.status || "draft");
    const kind = normalizeKindFromPricing(pricingType);

    const doc = {
      authority: "admin",
      createdByRole: "admin",
      codeType: "campaign",
      saleType: "flash",
      scope: "product",

      title,
      productIds,

      pricing: { type: pricingType, value: pricingValue },
      kind,
      value: pricingValue,

      limits,

      startAt,
      endAt,
      window: { startAt, endAt },

      status,
      isActive: status === "active",

      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const ins = await Discounts.insertOne(doc);
    res.json({ success: true, item: { ...doc, _id: ins.insertedId } });
  } catch (err) {
    console.error("POST /api/admin/flash-sales error:", err);
    res.status(500).json({ success: false, message: "Failed to create flash sale" });
  }
});

/* ===============================
   PATCH /api/admin/flash-sales/:id
=============================== */
router.patch("/:id", staffGuard, async (req, res) => {
  try {
    if (!ensureDiscountRole(req, res)) return;
    const id = toObjectId(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: "Invalid id" });

    const existing = await Discounts.findOne({ _id: id });
    if (!existing) return res.status(404).json({ success: false, message: "Not found" });
    if (String(existing.saleType || "").toLowerCase() !== "flash") {
      return res.status(400).json({ success: false, message: "Not a flash sale" });
    }

    const update = { $set: {}, $unset: {} };

    if (req.body?.title !== undefined) {
      update.$set.title = safeString(req.body.title);
    }

    if (req.body?.productIds !== undefined) {
      if (!Array.isArray(req.body.productIds)) {
        return res.status(400).json({ success: false, message: "productIds must be an array" });
      }

      const productIds = req.body.productIds
        .map((pid) => toObjectId(pid) || String(pid).trim())
        .filter(Boolean);

      // Allow clearing all products (e.g., removing the last item)
      update.$set.productIds = productIds;
    }

    const pricingTypeRaw = req.body?.pricing?.type ?? req.body?.kind;
    const pricingValueRaw = req.body?.pricing?.value ?? req.body?.value;
    if (pricingTypeRaw !== undefined || pricingValueRaw !== undefined) {
      const pricingType = normalizePricingType(pricingTypeRaw || existing?.pricing?.type || existing?.kind);
      const pricingValue = safeNumber(
        pricingValueRaw ?? existing?.pricing?.value ?? existing?.value,
        NaN
      );
      if (!pricingType || !Number.isFinite(pricingValue) || pricingValue <= 0) {
        return res
          .status(400)
          .json({ success: false, message: "Valid pricing.type and pricing.value are required" });
      }
      update.$set.pricing = { type: pricingType, value: pricingValue };
      update.$set.kind = normalizeKindFromPricing(pricingType);
      update.$set.value = pricingValue;
    }

    const startAtRaw = req.body?.startAt ?? req.body?.window?.startAt;
    const endAtRaw = req.body?.endAt ?? req.body?.window?.endAt;
    if (startAtRaw !== undefined || endAtRaw !== undefined) {
      const startAt = startAtRaw !== undefined ? parseDateOrNull(startAtRaw) : existing.startAt;
      const endAt = endAtRaw !== undefined ? parseDateOrNull(endAtRaw) : existing.endAt;
      if (!startAt || !endAt) {
        return res.status(400).json({ success: false, message: "startAt and endAt are required" });
      }
      if (startAt > endAt) {
        return res.status(400).json({ success: false, message: "startAt must be <= endAt" });
      }
      update.$set.startAt = startAt;
      update.$set.endAt = endAt;
      update.$set.window = { startAt, endAt };
    }

    if (req.body?.limits !== undefined) {
      update.$set.limits = {
        totalQty: safeInt(req.body?.limits?.totalQty ?? existing?.limits?.totalQty, 0),
        perUserQty: safeInt(req.body?.limits?.perUserQty ?? existing?.limits?.perUserQty, 0),
        perOrderQty: safeInt(req.body?.limits?.perOrderQty ?? existing?.limits?.perOrderQty, 0),
      };
    }

    if (req.body?.status !== undefined) {
      const status = normalizeStatus(req.body.status);
      update.$set.status = status;
      update.$set.isActive = status === "active";
    }

    update.$set.updatedAt = new Date();

    // Cleanup unset container if empty
    if (Object.keys(update.$unset).length === 0) delete update.$unset;

    const result = await Discounts.findOneAndUpdate({ _id: id }, update, {
      returnDocument: "after",
    });

    res.json({ success: true, item: result.value });
  } catch (err) {
    console.error("PATCH /api/admin/flash-sales/:id error:", err);
    res.status(500).json({ success: false, message: "Failed to update flash sale" });
  }
});

/* ===============================
   PATCH /api/admin/flash-sales/:id/status
=============================== */
router.patch("/:id/status", staffGuard, async (req, res) => {
  try {
    if (!ensureDiscountRole(req, res)) return;
    const id = toObjectId(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: "Invalid id" });

    const existing = await Discounts.findOne({ _id: id });
    if (!existing) return res.status(404).json({ success: false, message: "Not found" });
    if (String(existing.saleType || "").toLowerCase() !== "flash") {
      return res.status(400).json({ success: false, message: "Not a flash sale" });
    }

    const status = normalizeStatus(req.body?.status);
    const result = await Discounts.findOneAndUpdate(
      { _id: id },
      {
        $set: {
          status,
          isActive: status === "active",
          updatedAt: new Date(),
        },
      },
      { returnDocument: "after" }
    );

    res.json({ success: true, item: result.value });
  } catch (err) {
    console.error("PATCH /api/admin/flash-sales/:id/status error:", err);
    res.status(500).json({ success: false, message: "Failed to update status" });
  }
});

/* ===============================
   DELETE /api/admin/flash-sales/:id
=============================== */
router.delete("/:id", staffGuard, async (req, res) => {
  try {
    if (!ensureDiscountRole(req, res)) return;
    const id = toObjectId(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: "Invalid id" });

    const existing = await Discounts.findOne({ _id: id });
    if (!existing) return res.status(404).json({ success: false, message: "Not found" });
    if (String(existing.saleType || "").toLowerCase() !== "flash") {
      return res.status(400).json({ success: false, message: "Not a flash sale" });
    }

    const result = await Discounts.deleteOne({ _id: id });
    res.json({ success: true, deleted: result.deletedCount || 0 });
  } catch (err) {
    console.error("DELETE /api/admin/flash-sales/:id error:", err);
    res.status(500).json({ success: false, message: "Failed to delete flash sale" });
  }
});

export default router;
