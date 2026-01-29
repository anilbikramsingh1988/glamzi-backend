// routes/adminStorefrontConfigRoutes.js
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

const StorefrontConfig = db.collection("storefrontConfig");

const staffGuard = [authMiddleware, isActiveMiddleware, isStaffMiddleware];
const CONFIG_ID = "storefront-config";

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

function normalizeUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (raw.startsWith("http://") || raw.startsWith("https://")) return raw;
  return `https://${raw}`;
}

function buildDefaultConfig() {
  return {
    _id: CONFIG_ID,
    socialLinks: {
      facebook: "",
      instagram: "",
      tiktok: "",
      youtube: "",
      linkedin: "",
    },
    createdAt: new Date(),
    updatedAt: new Date(),
    updatedBy: null,
  };
}

function normalizeIncoming(body = {}) {
  const incoming = body.socialLinks || body || {};
  return {
    _id: CONFIG_ID,
    socialLinks: {
      facebook: normalizeUrl(incoming.facebook),
      instagram: normalizeUrl(incoming.instagram),
      tiktok: normalizeUrl(incoming.tiktok),
      youtube: normalizeUrl(incoming.youtube),
      linkedin: normalizeUrl(incoming.linkedin),
    },
  };
}

/**
 * GET /api/admin/configuration/storefront
 */
router.get("/admin/configuration/storefront", staffGuard, async (req, res) => {
  try {
    if (!ensureConfigRole(req, res)) return;

    let config = await StorefrontConfig.findOne({ _id: CONFIG_ID });
    if (!config) {
      const def = buildDefaultConfig();
      await StorefrontConfig.insertOne(def);
      config = def;
    }

    return res.json({ success: true, config });
  } catch (err) {
    console.error("GET storefront config error:", err);
    return res
      .status(500)
      .json({ success: false, message: "Failed to load storefront configuration" });
  }
});

/**
 * POST /api/admin/configuration/storefront
 * Body: { socialLinks: { facebook, instagram, tiktok, youtube, linkedin } }
 */
router.post("/admin/configuration/storefront", staffGuard, async (req, res) => {
  try {
    if (!ensureConfigRole(req, res)) return;

    const incoming = normalizeIncoming(req.body || {});
    const now = new Date();
    const adminId = req.user?.id || req.user?._id || null;

    await StorefrontConfig.updateOne(
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

    const saved = await StorefrontConfig.findOne({ _id: CONFIG_ID });

    return res.json({
      success: true,
      message: "Storefront configuration saved",
      config: saved,
    });
  } catch (err) {
    console.error("POST storefront config error:", err);
    return res
      .status(500)
      .json({ success: false, message: "Failed to save storefront configuration" });
  }
});

/**
 * GET /api/configuration/storefront/public
 */
router.get("/configuration/storefront/public", async (req, res) => {
  try {
    let config = await StorefrontConfig.findOne({ _id: CONFIG_ID });
    if (!config) {
      const def = buildDefaultConfig();
      await StorefrontConfig.insertOne(def);
      config = def;
    }

    return res.json({
      success: true,
      socialLinks: config.socialLinks || {},
    });
  } catch (err) {
    console.error("GET storefront public config error:", err);
    return res
      .status(500)
      .json({ success: false, message: "Failed to load storefront configuration" });
  }
});

export default router;
