// backend/lib/time.js (ESM)
import crypto from "crypto";

const KTM_OFFSET_MIN = 5 * 60 + 45; // +05:45

export function makeRunId() {
  return crypto.randomUUID();
}

export function nowUtcDate() {
  return new Date();
}

// Validate YYYY-MM-DD
export function parseBusinessDateOrThrow(s) {
  const v = String(s || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    throw new Error(`Invalid --date. Expected YYYY-MM-DD, got: ${v}`);
  }
  return v;
}

// “Yesterday” in Kathmandu, returned as YYYY-MM-DD
export function defaultBusinessDateKathmanduYesterday() {
  const now = new Date();
  const ktmMs = now.getTime() + KTM_OFFSET_MIN * 60_000;
  const ktm = new Date(ktmMs);

  // subtract 1 day in KTM date-space
  const y = ktm.getUTCFullYear();
  const m = ktm.getUTCMonth();
  const d = ktm.getUTCDate() - 1;

  const dt = new Date(Date.UTC(y, m, d, 0, 0, 0));
  const yyyy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Returns the UTC window for the Kathmandu business day YYYY-MM-DD.
 * Kathmandu midnight == UTC 18:15 of the previous UTC date.
 */
export function businessDayWindowUtc(businessDate /* YYYY-MM-DD */) {
  const s = parseBusinessDateOrThrow(businessDate);
  const [Y, M, D] = s.split("-").map((x) => Number(x));

  // Kathmandu local midnight -> UTC time is minus offset
  // So UTC timestamp for local midnight is: Date.UTC(Y,M-1,D,0,0,0) - offset
  const startLocalUtcMs = Date.UTC(Y, M - 1, D, 0, 0, 0) - KTM_OFFSET_MIN * 60_000;
  const endLocalUtcMs = Date.UTC(Y, M - 1, D + 1, 0, 0, 0) - KTM_OFFSET_MIN * 60_000;

  const fromUtc = new Date(startLocalUtcMs);
  const toUtc = new Date(endLocalUtcMs);

  return {
    businessDate: s,
    fromUtc,
    toUtc,
    fromUtcISO: fromUtc.toISOString(),
    toUtcISO: toUtc.toISOString(),
    tz: "Asia/Kathmandu",
  };
}
