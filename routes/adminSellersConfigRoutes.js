// routes/adminSellersConfigRoutes.js
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

const SellersConfig = db.collection("sellersConfig");

const staffGuard = [authMiddleware, isActiveMiddleware, isStaffMiddleware];

const CONFIG_ID = "sellers-config";

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

function cleanList(arr) {
  if (!Array.isArray(arr)) return [];
  return arr
    .map((x) => String(x || "").trim())
    .filter(Boolean)
    .slice(0, 200);
}

function buildDefaultConfig() {
  return {
    _id: CONFIG_ID,
    onboardingEnabled: true,
    requireEmailVerification: true,
    requirePhoneVerification: false,
    requireKyc: true,
    requiredDocuments: ["citizenship_front", "citizenship_back"],
    allowPanVat: true,
    allowBusinessRegistration: true,
    autoApproveVerifiedSellers: false,
    maxActiveProducts: 500,
    maxDailyProductUploads: 100,
    minPayoutThreshold: 500,
    commissionDefaultPercent: 10,
    allowCustomStoreSlug: true,
    requireStoreLogo: false,
    storeBioMaxLength: 500,
    sellerSupportSlaHours: 24,
    allowSellerChat: true,
    sellerTermsText:
      "By registering as a seller, you agree to comply with Glamzi seller policies, product authenticity rules, and refund regulations.",
    updatedAt: new Date(),
  };
}

function normalizeConfig(input = {}) {
  return {
    onboardingEnabled: b(input.onboardingEnabled),
    requireEmailVerification: b(input.requireEmailVerification),
    requirePhoneVerification: b(input.requirePhoneVerification),
    requireKyc: b(input.requireKyc),
    requiredDocuments: cleanList(input.requiredDocuments),
    allowPanVat: b(input.allowPanVat),
    allowBusinessRegistration: b(input.allowBusinessRegistration),
    autoApproveVerifiedSellers: b(input.autoApproveVerifiedSellers),
    maxActiveProducts: clamp(input.maxActiveProducts, 0, 100000),
    maxDailyProductUploads: clamp(input.maxDailyProductUploads, 0, 10000),
    minPayoutThreshold: clamp(input.minPayoutThreshold, 0, 10000000),
    commissionDefaultPercent: clamp(input.commissionDefaultPercent, 0, 100),
    allowCustomStoreSlug: b(input.allowCustomStoreSlug),
    requireStoreLogo: b(input.requireStoreLogo),
    storeBioMaxLength: clamp(input.storeBioMaxLength, 0, 5000),
    sellerSupportSlaHours: clamp(input.sellerSupportSlaHours, 0, 168),
    allowSellerChat: b(input.allowSellerChat),
    sellerTermsText: String(input.sellerTermsText || "").trim(),
    updatedAt: new Date(),
  };
}

/**
 * GET /api/admin/configuration/sellers
 */
router.get("/configuration/sellers", staffGuard, async (req, res) => {
  try {
    if (!ensureConfigRole(req, res)) return;

    const doc =
      (await SellersConfig.findOne({ _id: CONFIG_ID })) || buildDefaultConfig();

    if (!doc._id) doc._id = CONFIG_ID;

    res.json({ config: doc });
  } catch (err) {
    console.error("GET sellers config error:", err);
    res
      .status(500)
      .json({ success: false, message: "Failed to load sellers configuration" });
  }
});

/**
 * PUT /api/admin/configuration/sellers
 */
router.put("/configuration/sellers", staffGuard, async (req, res) => {
  try {
    if (!ensureConfigRole(req, res)) return;

    const payload = req.body?.config || req.body || {};
    const normalized = normalizeConfig(payload);

    const update = {
      $set: { ...normalized, _id: CONFIG_ID },
      $setOnInsert: { createdAt: new Date() },
    };

    await SellersConfig.updateOne({ _id: CONFIG_ID }, update, { upsert: true });

    res.json({
      success: true,
      message: "Sellers configuration saved",
      config: { ...normalized, _id: CONFIG_ID },
    });
  } catch (err) {
    console.error("PUT sellers config error:", err);
    res
      .status(500)
      .json({ success: false, message: "Failed to save sellers configuration" });
  }
});

export default router;
