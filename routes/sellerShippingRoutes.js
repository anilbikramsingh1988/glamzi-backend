import express from "express";
import axios from "axios";
import { authMiddleware } from "../middlewares/authMiddleware.js";

const router = express.Router();

function safeStr(v, max = 200) {
  const s = typeof v === "string" ? v.trim() : "";
  if (!s) return null;
  return s.length > max ? s.slice(0, max) : s;
}

function isSeller(req) {
  return req?.user?.role === "seller";
}

const SHIPPING_SERVICE_URL = String(process.env.SHIPPING_SERVICE_URL || "").trim();
const SHIPPING_INTERNAL_TOKEN = String(process.env.SHIPPING_INTERNAL_TOKEN || "").trim();

function shippingBaseUrl() {
  if (!SHIPPING_SERVICE_URL) return null;
  // Normalize to avoid accidental double /api/api when env contains /api suffix
  return SHIPPING_SERVICE_URL.replace(/\/+$/, "").replace(/\/api$/i, "");
}

function requireShippingConfig(res) {
  if (!shippingBaseUrl()) {
    res.status(500).json({ ok: false, error: "SHIPPING_SERVICE_URL not configured" });
    return false;
  }
  if (!SHIPPING_INTERNAL_TOKEN) {
    res.status(500).json({ ok: false, error: "SHIPPING_INTERNAL_TOKEN not configured" });
    return false;
  }
  return true;
}

router.get("/shipping/hubs", authMiddleware, async (req, res) => {
  try {
    if (!isSeller(req)) {
      return res.status(403).json({ ok: false, error: "Seller access only" });
    }

    if (!requireShippingConfig(res)) return;

    const url = `${shippingBaseUrl()}/api/hubs`;
    const response = await axios.get(url, {
      params: { page: 1, limit: 200, activeOnly: true },
      headers: {
        "Content-Type": "application/json",
        "x-internal-token": SHIPPING_INTERNAL_TOKEN,
      },
    });

    return res.json(response.data);
  } catch (err) {
    console.error("[GET /seller/shipping/hubs] error:", err);
    const status = err?.response?.status || 500;
    const msg = err?.response?.data?.error || err?.message || "Failed to load hubs";
    return res.status(status).json({ ok: false, error: msg });
  }
});

router.get("/shipping/zones", authMiddleware, async (req, res) => {
  try {
    if (!isSeller(req)) {
      return res.status(403).json({ ok: false, error: "Seller access only" });
    }

    if (!requireShippingConfig(res)) return;

    const hubId = safeStr(req.query?.hubId);
    if (!hubId) {
      return res.status(400).json({ ok: false, error: "HUB_ID_REQUIRED" });
    }

    const url = `${shippingBaseUrl()}/api/zones`;
    const response = await axios.get(url, {
      params: { hubId, limit: 200, activeOnly: true },
      headers: {
        "Content-Type": "application/json",
        "x-internal-token": SHIPPING_INTERNAL_TOKEN,
      },
    });

    return res.json(response.data);
  } catch (err) {
    console.error("[GET /seller/shipping/zones] error:", err);
    const status = err?.response?.status || 500;
    const msg = err?.response?.data?.error || err?.message || "Failed to load zones";
    return res.status(status).json({ ok: false, error: msg });
  }
});

router.post("/shipping/estimate", authMiddleware, async (req, res) => {
  try {
    if (!isSeller(req)) {
      return res.status(403).json({ ok: false, error: "Seller access only" });
    }

    if (!requireShippingConfig(res)) return;

    const body = req.body || {};
    const payload = {
      originHubCode: safeStr(body.originHubCode) || safeStr(body.hubKey),
      destHubCode: safeStr(body.destHubCode) || safeStr(body.hubKey),
      zoneCode: safeStr(body.zoneCode) || safeStr(body.zoneKey),
      actualWeightKg: body.actualWeightKg,
      dimsCm: body.dimsCm,
      isCod: body.isCod,
      orderValueNpr: body.orderValueNpr,
      flags: body.flags,
    };

    const url = `${shippingBaseUrl()}/api/shipments/estimate`;

    const r = await axios.post(url, payload, {
      timeout: 12000,
      headers: {
        "Content-Type": "application/json",
        "x-internal-token": SHIPPING_INTERNAL_TOKEN,
      },
    });

    return res.json(r.data);
  } catch (err) {
    const status = err?.response?.status || 500;
    const msg = err?.response?.data?.error || err?.message || "Estimate failed";
    return res.status(status).json({ ok: false, error: msg });
  }
});

export default router;
