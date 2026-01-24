// routes/adminSellerPaymentConfigRoutes.js
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

const SellerPaymentConfig = db.collection("sellerPaymentConfig");

// Staff guard (admin/staff)
const staffGuard = [authMiddleware, isActiveMiddleware, isStaffMiddleware];

// Roles allowed to manage finance configurations
function ensureFinanceRole(req, res) {
  const role = String(req.user?.role || "").toLowerCase();
  const allowed = ["super-admin", "admin", "account"];
  if (!allowed.includes(role)) {
    res.status(403).json({
      success: false,
      message: "Finance access only (super-admin, admin, account).",
    });
    return false;
  }
  return true;
}

const CONFIG_ID = "seller-payment-config";

function normalizeBool(v) {
  return Boolean(v);
}

function normalizeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeSettlementCycle(v) {
  const s = String(v || "").toLowerCase();
  if (["daily", "weekly", "monthly"].includes(s)) return s;
  return "weekly";
}

function normalizeMethods(obj = {}) {
  const safe = {
    bank: normalizeBool(obj.bank),
    esewa: normalizeBool(obj.esewa),
    khalti: normalizeBool(obj.khalti),
    imepay: normalizeBool(obj.imepay),
  };
  // Ensure at least one method enabled
  if (!safe.bank && !safe.esewa && !safe.khalti && !safe.imepay) {
    safe.bank = true;
  }
  return safe;
}

function normalizeRequiredFields(obj = {}) {
  return {
    bankAccountName: normalizeBool(obj.bankAccountName),
    bankAccountNumber: normalizeBool(obj.bankAccountNumber),
    bankName: normalizeBool(obj.bankName),
    walletId: normalizeBool(obj.walletId),
  };
}

function buildDefaultConfig() {
  return {
    _id: CONFIG_ID,
    autoPayout: false,
    settlementCycle: "weekly",
    minPayoutAmount: 500,
    methods: {
      bank: true,
      esewa: true,
      khalti: false,
      imepay: false,
    },
    requiredFields: {
      bankAccountName: true,
      bankAccountNumber: true,
      bankName: true,
      walletId: false,
    },
    createdAt: new Date(),
    updatedAt: new Date(),
    updatedBy: null,
  };
}

/**
 * GET /api/admin/payments/seller-configuration
 */
router.get("/payments/seller-configuration", staffGuard, async (req, res) => {
  try {
    if (!ensureFinanceRole(req, res)) return;

    let config = await SellerPaymentConfig.findOne({ _id: CONFIG_ID });

    // If missing, auto-create defaults (so UI always works)
    if (!config) {
      const def = buildDefaultConfig();
      await SellerPaymentConfig.insertOne(def);
      config = def;
    }

    return res.json({ success: true, config });
  } catch (err) {
    console.error("GET seller payment config error:", err);
    return res
      .status(500)
      .json({ success: false, message: "Failed to load configuration" });
  }
});

/**
 * POST /api/admin/payments/seller-configuration
 * Body:
 *  {
 *    autoPayout,
 *    settlementCycle,
 *    minPayoutAmount,
 *    methods: { bank, esewa, khalti, imepay },
 *    requiredFields: { bankAccountName, bankAccountNumber, bankName, walletId }
 *  }
 */
router.post("/payments/seller-configuration", staffGuard, async (req, res) => {
  try {
    if (!ensureFinanceRole(req, res)) return;

    const body = req.body || {};

    const nextConfig = {
      autoPayout: normalizeBool(body.autoPayout),
      settlementCycle: normalizeSettlementCycle(body.settlementCycle),
      minPayoutAmount: Math.max(0, normalizeNum(body.minPayoutAmount, 500)),
      methods: normalizeMethods(body.methods || {}),
      requiredFields: normalizeRequiredFields(body.requiredFields || {}),
      updatedAt: new Date(),
      updatedBy: req.user?.id || req.user?._id || null,
    };

    // Upsert a single global document
    await SellerPaymentConfig.updateOne(
      { _id: CONFIG_ID },
      {
        $set: nextConfig,
        $setOnInsert: {
          _id: CONFIG_ID,
          createdAt: new Date(),
        },
      },
      { upsert: true }
    );

    const saved = await SellerPaymentConfig.findOne({ _id: CONFIG_ID });

    return res.json({
      success: true,
      message: "Seller payment configuration saved",
      config: saved,
    });
  } catch (err) {
    console.error("POST seller payment config error:", err);
    return res
      .status(500)
      .json({ success: false, message: "Failed to save configuration" });
  }
});

export default router;
