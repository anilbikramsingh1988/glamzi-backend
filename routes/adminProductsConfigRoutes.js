// routes/adminProductsConfigRoutes.js
import express from "express";
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

const ProductsConfig = db.collection("productsConfig");

const staffGuard = [authMiddleware, isActiveMiddleware, isStaffMiddleware];

const CONFIG_ID = "products-config";

function ensureConfigRole(req, res) {
  const role = String(req.user?.role || "").toLowerCase();
  const allowed = ["super-admin", "admin", "marketing"];
  if (!allowed.includes(role)) {
    res.status(403).json({
      success: false,
      message: "Configuration access only (super-admin, admin, marketing).",
    });
    return false;
  }
  return true;
}

function b(v) {
  return Boolean(v);
}

function n(v, fallback) {
  const x = Number(v);
  return Number.isFinite(x) ? x : fallback;
}

function clamp(v, minV, maxV) {
  const x = n(v, minV);
  return Math.min(maxV, Math.max(minV, x));
}

function normalizeCurrency(v) {
  const s = String(v || "NPR").toUpperCase().trim();
  const allowed = ["NPR", "USD", "AED", "INR"];
  return allowed.includes(s) ? s : "NPR";
}

function normalizeWeightUnit(v) {
  const s = String(v || "kg").toLowerCase().trim();
  const allowed = ["kg", "g", "lb", "oz"];
  return allowed.includes(s) ? s : "kg";
}

function cleanList(arr) {
  if (!Array.isArray(arr)) return [];
  return arr
    .map((x) => String(x || "").trim())
    .filter(Boolean)
    .slice(0, 500); // hard safety cap
}

function buildDefaultConfig() {
  return {
    _id: CONFIG_ID,

    moderation: {
      requireApproval: true,
      autoApproveVerifiedSellers: false,
      autoRejectBannedWords: true,
    },

    limits: {
      maxImages: 8,
      maxVariants: 20,
      maxTitleLen: 120,
      maxDescLen: 5000,
    },

    pricing: {
      defaultCurrency: "NPR",
      allowNegotiation: true,
      minPrice: 1,
      maxPrice: 10000000,
      requireCompareAtToBeHigher: true,
    },

    inventory: {
      trackStock: true,
      lowStockThreshold: 5,
      allowBackorder: false,
    },

    shipping: {
      requireWeight: false,
      requireDimensions: false,
      weightUnit: "kg",
    },

    visibility: {
      allowDraft: true,
      allowSchedule: true,
      allowHideOutOfStock: false,
    },

    seo: {
      autoSlug: true,
      enforceUniqueSlug: true,
      appendBrandToTitle: false,
    },

    content: {
      bannedWords: [],
      blockedDomains: [],
    },

    createdAt: new Date(),
    updatedAt: new Date(),
    updatedBy: null,
  };
}

function normalizeIncoming(body = {}) {
  const moderation = body.moderation || {};
  const limits = body.limits || {};
  const pricing = body.pricing || {};
  const inventory = body.inventory || {};
  const shipping = body.shipping || {};
  const visibility = body.visibility || {};
  const seo = body.seo || {};
  const content = body.content || {};

  const normalized = {
    _id: CONFIG_ID,

    moderation: {
      requireApproval: b(moderation.requireApproval),
      autoApproveVerifiedSellers: b(moderation.autoApproveVerifiedSellers),
      autoRejectBannedWords: b(moderation.autoRejectBannedWords),
    },

    limits: {
      maxImages: clamp(limits.maxImages, 1, 25),
      maxVariants: clamp(limits.maxVariants, 0, 200),
      maxTitleLen: clamp(limits.maxTitleLen, 30, 255),
      maxDescLen: clamp(limits.maxDescLen, 200, 20000),
    },

    pricing: {
      defaultCurrency: normalizeCurrency(pricing.defaultCurrency),
      allowNegotiation: b(pricing.allowNegotiation),
      minPrice: Math.max(0, n(pricing.minPrice, 0)),
      maxPrice: Math.max(0, n(pricing.maxPrice, 0)),
      requireCompareAtToBeHigher: b(pricing.requireCompareAtToBeHigher),
    },

    inventory: {
      trackStock: b(inventory.trackStock),
      lowStockThreshold: clamp(inventory.lowStockThreshold, 0, 9999),
      allowBackorder: b(inventory.allowBackorder),
    },

    shipping: {
      requireWeight: b(shipping.requireWeight),
      requireDimensions: b(shipping.requireDimensions),
      weightUnit: normalizeWeightUnit(shipping.weightUnit),
    },

    visibility: {
      allowDraft: b(visibility.allowDraft),
      allowSchedule: b(visibility.allowSchedule),
      allowHideOutOfStock: b(visibility.allowHideOutOfStock),
    },

    seo: {
      autoSlug: b(seo.autoSlug),
      enforceUniqueSlug: b(seo.enforceUniqueSlug),
      appendBrandToTitle: b(seo.appendBrandToTitle),
    },

    content: {
      bannedWords: cleanList(content.bannedWords),
      blockedDomains: cleanList(content.blockedDomains),
    },
  };

  // Ensure maxPrice >= minPrice
  if (normalized.pricing.maxPrice < normalized.pricing.minPrice) {
    normalized.pricing.maxPrice = normalized.pricing.minPrice;
  }

  return normalized;
}

/**
 * GET /api/admin/configuration/products/public
 * PUBLIC endpoint - Returns only seller-relevant config limits (no banned words, etc.)
 * Used by seller product creation form to validate inputs
 */
router.get("/configuration/products/public", async (req, res) => {
  try {
    let config = await ProductsConfig.findOne({ _id: CONFIG_ID });
    
    if (!config) {
      const def = buildDefaultConfig();
      await ProductsConfig.insertOne(def);
      config = def;
    }

    return res.json({
      success: true,
      config: {
        limits: config.limits || { maxImages: 8, maxVariants: 20, maxTitleLen: 120, maxDescLen: 5000 },
        pricing: {
          defaultCurrency: config.pricing?.defaultCurrency || "NPR",
          minPrice: config.pricing?.minPrice || 1,
          maxPrice: config.pricing?.maxPrice || 10000000,
          allowNegotiation: config.pricing?.allowNegotiation || false,
          requireCompareAtToBeHigher: config.pricing?.requireCompareAtToBeHigher || true,
        },
        inventory: {
          trackStock: config.inventory?.trackStock ?? true,
          lowStockThreshold: config.inventory?.lowStockThreshold || 5,
          allowBackorder: config.inventory?.allowBackorder || false,
        },
        shipping: config.shipping || { requireWeight: false, requireDimensions: false, weightUnit: "kg" },
        visibility: {
          allowDraft: config.visibility?.allowDraft ?? true,
          allowSchedule: config.visibility?.allowSchedule ?? true,
        },
        moderation: {
          requireApproval: config.moderation?.requireApproval ?? true,
        },
      },
    });
  } catch (err) {
    console.error("GET public products config error:", err);
    return res.status(500).json({ success: false, message: "Failed to load product config" });
  }
});

/**
 * GET /api/admin/configuration/products
 * Returns: { success: true, config }
 */
router.get("/configuration/products", staffGuard, async (req, res) => {
  try {
    if (!ensureConfigRole(req, res)) return;

    let config = await ProductsConfig.findOne({ _id: CONFIG_ID });

    // Auto-create defaults to keep UI stable
    if (!config) {
      const def = buildDefaultConfig();
      await ProductsConfig.insertOne(def);
      config = def;
    }

    return res.json({ success: true, config });
  } catch (err) {
    console.error("GET products config error:", err);
    return res
      .status(500)
      .json({ success: false, message: "Failed to load products configuration" });
  }
});

/**
 * POST /api/admin/configuration/products
 * Body: config object
 * Returns: { success: true, message, config }
 */
router.post("/configuration/products", staffGuard, async (req, res) => {
  try {
    if (!ensureConfigRole(req, res)) return;

    const incoming = normalizeIncoming(req.body || {});
    const now = new Date();
    const adminId = req.user?.id || req.user?._id || null;

    await ProductsConfig.updateOne(
      { _id: CONFIG_ID },
      {
        $set: {
          ...incoming,
          updatedAt: now,
          updatedBy: adminId,
        },
        $setOnInsert: {
          _id: CONFIG_ID,
          createdAt: now,
        },
      },
      { upsert: true }
    );

    const saved = await ProductsConfig.findOne({ _id: CONFIG_ID });

    return res.json({
      success: true,
      message: "Products configuration saved",
      config: saved,
    });
  } catch (err) {
    console.error("POST products config error:", err);
    return res
      .status(500)
      .json({ success: false, message: "Failed to save products configuration" });
  }
});

export default router;
