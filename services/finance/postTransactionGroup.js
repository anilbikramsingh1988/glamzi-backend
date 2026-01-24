// services/finance/postTransactionGroup.js (ESM)
//
// Guarantees:
// - Each leg is stored with amount>0 and dc in {"debit","credit"}
// - Sum(debits) === Sum(credits) (balanced group)
// - Idempotent via unique index uniq_txn_leg on (transactionGroupId, accountKey, dc, amount, sourceRef)
// - Safe retries: duplicate-key => treat as already-posted
//
// Requires MongoDB index:
// db.gl_ledger_entries.createIndex(
//   { transactionGroupId: 1, accountKey: 1, dc: 1, amount: 1, sourceRef: 1 },
//   { name: "uniq_txn_leg", unique: true, partialFilterExpression: { transactionGroupId: { $type: "string" } } }
// )

import crypto from "crypto";

function toNum(v, def = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function toStr(v, def = "") {
  return v == null ? def : String(v);
}

function pickStr(v) {
  return typeof v === "string" ? v.trim() : "";
}

function isNonEmpty(v) {
  return typeof v === "string" && v.trim() !== "";
}

function normalizeDc(dc) {
  const s = toStr(dc).toLowerCase();
  if (s === "debit") return "debit";
  if (s === "credit") return "credit";
  return "";
}

function makeGroupId(prefix = "tg") {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(6).toString("hex")}`;
}

function isDuplicateKeyError(err) {
  const msg = String(err?.message || "");
  return err?.code === 11000 || msg.includes("E11000 duplicate key");
}

export async function postTransactionGroup(db, input) {
  const Ledger = db.collection("gl_ledger_entries");

  const transactionGroupId = pickStr(input?.transactionGroupId) || makeGroupId("tg");
  const postedAt = input?.postedAt ? new Date(input.postedAt) : new Date();

  const legsIn = Array.isArray(input?.legs) ? input.legs : [];
  if (!legsIn.length) {
    return { ok: false, transactionGroupId, posted: 0, reason: "No legs provided" };
  }

  const sourceRef = pickStr(input?.sourceRef || "");
  const categoryDefault = pickStr(input?.category || "");
  const noteDefault = pickStr(input?.note || "");

  const legs = legsIn.map((l) => {
    const accountKey = pickStr(l?.accountKey);
    const dc = normalizeDc(l?.dc);
    const amount = Math.abs(toNum(l?.amount, 0));

    return {
      accountKey,
      dc,
      amount,
      category: pickStr(l?.category || categoryDefault),
      sourceRef: pickStr(l?.sourceRef || sourceRef),
      note: pickStr(l?.note || noteDefault),
      accountName: pickStr(l?.accountName || ""),
      sellerId: pickStr(l?.sellerId || ""),
      sellerName: pickStr(l?.sellerName || ""),
      orderId: l?.orderId || null,
      orderNumber: pickStr(l?.orderNumber || ""),
      invoiceNumber: pickStr(l?.invoiceNumber || ""),
      meta: l?.meta && typeof l.meta === "object" ? l.meta : null,
    };
  });

  for (const l of legs) {
    if (!isNonEmpty(l.accountKey)) {
      return { ok: false, transactionGroupId, posted: 0, reason: "Missing accountKey in leg" };
    }
    if (l.dc !== "debit" && l.dc !== "credit") {
      return { ok: false, transactionGroupId, posted: 0, reason: "Invalid dc in leg" };
    }
    if (!(l.amount > 0)) {
      return { ok: false, transactionGroupId, posted: 0, reason: "Invalid amount in leg" };
    }
    if (!isNonEmpty(l.sourceRef)) {
      return { ok: false, transactionGroupId, posted: 0, reason: "Missing sourceRef in leg" };
    }
  }

  const sumDebit = legs.reduce((a, l) => a + (l.dc === "debit" ? l.amount : 0), 0);
  const sumCredit = legs.reduce((a, l) => a + (l.dc === "credit" ? l.amount : 0), 0);
  const tol = 0.000001;
  if (Math.abs(sumDebit - sumCredit) > tol) {
    return {
      ok: false,
      transactionGroupId,
      posted: 0,
      reason: `Unbalanced group: debit=${sumDebit} credit=${sumCredit}`,
    };
  }

  const docs = legs.map((l) => ({
    postedAt,
    transactionGroupId,
    accountKey: l.accountKey,
    accountName: l.accountName || null,
    dc: l.dc,
    amount: l.amount,
    category: l.category || null,
    sourceRef: l.sourceRef,
    note: l.note || null,
    sellerId: l.sellerId || null,
    sellerName: l.sellerName || null,
    orderId: l.orderId || null,
    orderNumber: l.orderNumber || null,
    invoiceNumber: l.invoiceNumber || null,
    meta: l.meta || null,
    createdAt: new Date(),
    updatedAt: new Date(),
  }));

  try {
    const result = await Ledger.insertMany(docs, { ordered: false });
    return { ok: true, transactionGroupId, posted: result?.insertedCount || docs.length, idempotent: false };
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    return { ok: true, transactionGroupId, posted: 0, idempotent: true };
  }
}
