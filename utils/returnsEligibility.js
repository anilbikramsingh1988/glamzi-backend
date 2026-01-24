const DEFAULT_WINDOW_DAYS = Number(process.env.RETURN_WINDOW_DAYS || 7);

function now() {
  return new Date();
}

function toNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

function toPosInt(x) {
  const n = Math.floor(toNum(x));
  return n > 0 ? n : 0;
}

function safeStr(x, max = 500) {
  const s = typeof x === "string" ? x.trim() : "";
  if (!s) return "";
  return s.length > max ? s.slice(0, max) : s;
}

function normalizeEvidence(e) {
  if (!Array.isArray(e)) return [];
  return e
    .map((v) => {
      if (!v) return null;
      if (typeof v === "string") return { url: v };
      if (typeof v === "object") {
        const url = safeStr(v.url || v.key || v.path || "");
        if (!url) return null;
        return {
          url,
          type: safeStr(v.type || "image", 30) || "image",
          name: safeStr(v.name || "", 120),
        };
      }
      return null;
    })
    .filter(Boolean);
}

export function computeReturnWindow({
  deliveredAt,
  windowDays = DEFAULT_WINDOW_DAYS,
  nowAt, // optional injection for tests
}) {
  const current = nowAt instanceof Date ? nowAt : now();
  const d = deliveredAt ? new Date(deliveredAt) : null;
  if (!d || Number.isNaN(d.getTime())) return { ok: false, reason: "NOT_DELIVERED" };

  const days = Math.max(0, Math.floor(toNum(windowDays)));
  const windowEndAt = new Date(d.getTime() + days * 24 * 60 * 60 * 1000);

  const ok = current.getTime() <= windowEndAt.getTime();

  return {
    ok,
    deliveredAt: d,
    windowDays: days,
    windowStartAt: d,
    windowEndAt,
    reason: ok ? null : "WINDOW_EXPIRED",
    nowAt: current,
  };
}

/**
 * validateReturnRequest()
 * - order: { items: [{ orderItemId, qty, sellerId, deliveredAt? }], deliveredAt? }
 * - requestedItems: [{ orderItemId, qty, reasonCode?, reasonText?, evidence? }]
 * - existingByOrderItemId: Map(orderItemId -> { pendingOrApprovedQty })
 */
export function validateReturnRequest({
  order,
  requestedItems,
  existingByOrderItemId,
  windowDays = DEFAULT_WINDOW_DAYS, // allow override (e.g., seller/category policy)
}) {
  const errors = [];
  const valid = [];

  const orderItems = Array.isArray(order?.items) ? order.items : [];
  const nowAt = now(); // single snapshot

  for (const r of Array.isArray(requestedItems) ? requestedItems : []) {
    const orderItemId = safeStr(String(r?.orderItemId || ""), 80);
    const qtyReq = toPosInt(r?.qty);

    if (!orderItemId || qtyReq <= 0) {
      errors.push({ orderItemId, code: "INVALID_ITEM" });
      continue;
    }

    const oi = orderItems.find((x) => safeStr(String(x?.orderItemId || ""), 80) === orderItemId);
    if (!oi) {
      errors.push({ orderItemId, code: "ITEM_NOT_IN_ORDER" });
      continue;
    }

    const deliveredAt = oi?.deliveredAt || order?.deliveredAt || null;
    const window = computeReturnWindow({ deliveredAt, windowDays, nowAt });

    if (!window.ok) {
      errors.push({
        orderItemId,
        code: window.reason || "NOT_ELIGIBLE",
        windowEndAt: window.windowEndAt || null,
      });
      continue;
    }

    const qtyOrdered = toPosInt(oi?.qty);
    const already = toPosInt(existingByOrderItemId?.get?.(orderItemId)?.pendingOrApprovedQty || 0);
    const remainingRaw = qtyOrdered - already;
    const remaining = remainingRaw > 0 ? remainingRaw : 0;

    if (qtyReq > remaining) {
      errors.push({ orderItemId, code: "QTY_EXCEEDS_REMAINING", remaining });
      continue;
    }

    valid.push({
      orderItemId,
      sellerId: safeStr(String(oi?.sellerId || ""), 80),
      deliveredAt: window.deliveredAt,
      returnWindowDays: window.windowDays,
      returnWindowStartAt: window.windowStartAt,
      returnWindowEndAt: window.windowEndAt,
      qtyRequested: qtyReq,
      reasonCode: safeStr(String(r?.reasonCode || "other"), 60) || "other",
      reasonText: safeStr(String(r?.reasonText || ""), 1000),
      evidence: normalizeEvidence(r?.evidence),
    });
  }

  // Keep your original semantics: ok only if zero errors.
  return { ok: errors.length === 0, valid, errors };
}
