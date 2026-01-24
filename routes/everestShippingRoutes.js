import express from "express";
import axios from "axios";

const router = express.Router();

const SHIPPING_SERVICE_URL = String(process.env.SHIPPING_SERVICE_URL || "").trim();
const SHIPPING_INTERNAL_TOKEN = String(process.env.SHIPPING_INTERNAL_TOKEN || "").trim();

function shippingBaseUrl() {
  if (!SHIPPING_SERVICE_URL) return null;
  return SHIPPING_SERVICE_URL.replace(/\/+$/, "");
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

function safeStr(v, max = 200) {
  const s = typeof v === "string" ? v.trim() : "";
  if (!s) return null;
  return s.length > max ? s.slice(0, max) : s;
}

function toNum(v, def = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function normalizeDims(input) {
  const dims = input && typeof input === "object" ? input : null;
  if (!dims) return null;
  const lengthCm = toNum(dims.lengthCm ?? dims.length, 0);
  const widthCm = toNum(dims.widthCm ?? dims.width, 0);
  const heightCm = toNum(dims.heightCm ?? dims.height, 0);
  if (lengthCm <= 0 && widthCm <= 0 && heightCm <= 0) return null;
  return {
    lengthCm: lengthCm > 0 ? lengthCm : null,
    widthCm: widthCm > 0 ? widthCm : null,
    heightCm: heightCm > 0 ? heightCm : null,
  };
}

router.post("/estimate", async (req, res) => {
  if (!requireShippingConfig(res)) return;

  try {
    const body = req.body || {};
    const originHubCode = safeStr(body.originHubCode) || safeStr(body.hubCode);
    const destHubCandidate =
      safeStr(body.destHubCode) ||
      safeStr(body.zoneHubCode) ||
      safeStr(body.zone?.hub?.code) ||
      originHubCode;
    const zoneCode = safeStr(body.zoneCode) || safeStr(body.zoneKey);

    if (!originHubCode || !zoneCode) {
      return res.status(400).json({ ok: false, error: "ROUTE_INFO_REQUIRED" });
    }

    const payload = {
      originHubCode,
      destHubCode: destHubCandidate,
      zoneCode,
      actualWeightKg: toNum(body.actualWeightKg ?? body.weight ?? 0, 0),
      dimsCm: normalizeDims(body.dimsCm ?? body.dimensions ?? null),
      isCod: !!body.isCod,
      orderValueNpr: toNum(body.orderValueNpr ?? body.orderValue ?? body.amount ?? 0, 0),
      flags: typeof body.flags === "object" ? body.flags : {},
    };

    const url = `${shippingBaseUrl()}/api/shipments/estimate`;
    const response = await axios.post(url, payload, {
      timeout: 12000,
      headers: {
        "Content-Type": "application/json",
        "x-internal-token": SHIPPING_INTERNAL_TOKEN,
      },
    });

    return res.json(response.data);
  } catch (err) {
    console.error("[POST /everest/shipping/estimate] error:", err);
    const status = err?.response?.status || 500;
    const msg = err?.response?.data?.error || err?.message || "Estimate failed";
    return res.status(status).json({ ok: false, error: msg });
  }
});

export default router;
