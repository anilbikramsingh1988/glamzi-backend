// routes/adminOrdersRoutes.js
import express from "express";
import dotenv from "dotenv";
import { ObjectId } from "mongodb";

import { client, getDB } from "../dbConfig.js";
import { postTransactionGroup } from "../services/finance/postTransactionGroup.js";
import { authMiddleware, isActiveMiddleware } from "../middlewares/authMiddleware.js";
import { bookShipmentFactory, bookReturnShipment } from "../utils/shippingBridge.js";
import { enqueueNotification } from "../utils/outbox.js";
import {
  RETURN_STATUS,
  canTransitionReturnStatus,
  normalizeReturnStatus,
} from "../utils/returnsStatus.js";

dotenv.config();
const router = express.Router();
console.log("✅ LOADED: adminOrdersRoutes.js (expected mount: /api/admin/orders)");

/* ===============================
   DB SETUP
=============================== */
const dbName = process.env.DB_NAME || "glamzi_ecommerce";
const db = client.db(dbName);

const Orders = db.collection("orders");
const Users = db.collection("users");
const Invoices = db.collection("invoices");
const Returns = db.collection("returns");
const ReturnShipments = db.collection("returnShipments");
const bookShipmentFireAndForget = bookShipmentFactory({ Orders });

// ✅ NEW: commission settings collection (global)
const CommissionSettings = db.collection("commissionSettings");

// ✅ audit collections
const OrderAuditLogs = db.collection("orderAuditLogs");
const InvoiceAuditLogs = db.collection("invoiceAuditLogs");

/* ===============================
   HELPERS
=============================== */
function escapeRegex(input = "") {
  return String(input).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toObjectId(id) {
  try {
    if (!id) return null;
    if (id instanceof ObjectId) return id;
    const s = String(id).trim();
    if (!ObjectId.isValid(s)) return null;
    return new ObjectId(s);
  } catch {
    return null;
  }
}

function safeString(v, max = 500) {
  if (typeof v !== "string") return "";
  const s = v.trim();
  return s.length > max ? s.slice(0, max) : s;
}

function normalizeStatus(s) {
  return String(s || "").trim().toLowerCase();
}

function normalizePayStatus(s) {
  const v = String(s || "").trim().toLowerCase();
  return v === "paid" ? "paid" : "pending";
}

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function deriveOrderPaymentStatus(order = {}) {
  const method = normalizeStatus(order.paymentMethod || "");

  if (method !== "cod") return normalizeStatus(order.paymentStatus || "pending");

  if (order?.sellerPayments && typeof order.sellerPayments === "object") {
    const segs = Object.values(order.sellerPayments || {});
    if (!segs.length) return "pending";
    const allPaid = segs.every(
      (s) => normalizeStatus(s?.status || "") === "paid"
    );
    return allPaid ? "paid" : "pending";
  }

  if (order?.sellerFulfillment && typeof order.sellerFulfillment === "object") {
    const segs = Object.values(order.sellerFulfillment || {});
    if (!segs.length) return "pending";
    const paidCount = segs.filter(
      (s) => normalizeStatus(s?.paymentStatus) === "paid"
    ).length;
    return paidCount === segs.length ? "paid" : "pending";
  }

  return "pending";
}

const ensureAdminForOrders = (req, res, next) => {
  const role = String(req.user?.role || "").toLowerCase();
  const allowed = ["super-admin", "admin", "account"]; // orders module
  if (allowed.includes(role)) return next();
  return res.status(403).json({ message: "Admin access only" });
};

function parseDateStart(v) {
  if (!v) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  d.setHours(0, 0, 0, 0);
  return d;
}

function parseDateEnd(v) {
  if (!v) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  d.setHours(23, 59, 59, 999);
  return d;
}

function mapSort(sortBy = "createdAt", sortDir = "desc") {
  const dir = String(sortDir).toLowerCase() === "asc" ? 1 : -1;

  // ✅ IMPORTANT:
  // - totalAmount uses computed _totalAmount
  // - paymentStatus uses computed _paymentStatusEffective
  const sortField =
    sortBy === "totalAmount"
      ? "_totalAmount"
      : sortBy === "paymentStatus"
      ? "_paymentStatusEffective"
      : sortBy === "status"
      ? "status"
      : "createdAt";

  return { [sortField]: dir, createdAt: -1 };
}

function getActorId(req) {
  return String(req.user?._id || req.user?.id || req.user?.email || "admin");
}

function getReturnSellerId(order) {
  const items = Array.isArray(order?.items) ? order.items : [];
  for (const item of items) {
    const sid =
      item?.sellerId ||
      item?.product?.sellerId ||
      item?.userId ||
      item?.seller?._id ||
      item?.seller?.id;
    if (sid) return String(sid);
  }
  return null;
}

const ADMIN_RETURN_STATUSES = [
  "pickup_scheduled",
  "picked_up",
  "received_at_hub",
  "refunded",
  "cancelled",
];

const ADMIN_RETURN_NEXT = {
  null: ["pickup_scheduled"],
  pickup_scheduled: ["picked_up", "cancelled"],
  picked_up: ["received_at_hub", "cancelled"],
  received_at_hub: ["refunded"],
  refunded: [],
  cancelled: [],
};

function getAdminReturnStatus(order) {
  const s = normalizeStatus(order?.returnAdmin?.status || "");
  return ADMIN_RETURN_STATUSES.includes(s) ? s : null;
}

function canTransitionAdminReturn(current, next) {
  const curKey = current || null;
  const allowed = ADMIN_RETURN_NEXT[curKey] || [];
  return allowed.includes(next);
}

const AUTO_REFUND_RETURN_AFTER_RECEIVED =
  String(process.env.AUTO_REFUND_RETURN_AFTER_RECEIVED ?? "true")
    .trim()
    .toLowerCase() !== "false";

function moneyNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function asDateOrNull(v) {
  if (!v) return null;
  const dt = new Date(v);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

function computeAutoRefundAmount(orderDoc) {
  const candidates = [
    orderDoc?.returnAdmin?.refund?.amount,
    orderDoc?.refundTotal,
    orderDoc?.returnRequest?.refundAmount,
    orderDoc?.totals?.grandTotal,
    orderDoc?.totalAmount,
    orderDoc?.payment?.amount,
    orderDoc?.payment?.capturedAmount,
  ];
  for (const candidate of candidates) {
    const num = moneyNum(candidate);
    if (num > 0) return num;
  }
  return 0;
}

function computeAutoRefundMethod(orderDoc) {
  const source =
    orderDoc?.returnAdmin?.refund?.method ||
    orderDoc?.payment?.method ||
    orderDoc?.paymentMethod ||
    orderDoc?.payment?.paymentMethod ||
    "online";
  return normalizeStatus(safeString(source)) || "online";
}

function shouldAutoRefundReturn(orderDoc) {
  if (!AUTO_REFUND_RETURN_AFTER_RECEIVED) return false;
  if (!orderDoc?.returnRequest) return false;
  if (normalizeStatus(orderDoc?.returnAdmin?.status) === "refunded") return false;
  if (normalizeStatus(orderDoc?.status) === "refunded") return false;
  return true;
}

async function autoRefundReturn(orderDoc, actorId) {
  const now = new Date();
  const amount = computeAutoRefundAmount(orderDoc);
  const method = computeAutoRefundMethod(orderDoc);
  const reference =
    safeString(orderDoc?.returnAdmin?.refund?.ref) || `auto-${now.getTime()}`;
  const note = "Auto refund after receipt";

  const patch = {
    $set: {
      "returnAdmin.status": "refunded",
      "returnAdmin.updatedAt": now,
      "returnAdmin.updatedBy": actorId,
      "returnAdmin.refundedAt": now,
      "returnAdmin.refund": {
        method: method || null,
        amount: amount > 0 ? amount : null,
        ref: reference || null,
        note,
      },
      "returnRequest.status": "refunded",
      status: "refunded",
      refundedAt: now,
      "returnRequest.updatedAt": now,
    },
    $push: {
      "returnRequest.history": {
        status: "admin_refunded",
        at: now,
        actor: actorId,
        note,
      },
    },
  };

  await Orders.updateOne({ _id: orderDoc._id }, patch);
  return Orders.findOne({ _id: orderDoc._id });
}

/**
 * Admin status -> sellerFulfillment status mapping
 * Admin UI uses: pending/accepted/processing/shipped/delivered/completed
 * Seller fulfillment uses: created/confirmed/processing/shipped/delivered/completed
 */
function adminStatusToSellerStatus(adminStatus) {
  const s = normalizeStatus(adminStatus);
  if (s === "pending") return "created";
  if (s === "accepted") return "confirmed";
  return s;
}

function timestampFieldForStatus(status) {
  const map = {
    created: "createdAt",
    confirmed: "confirmedAt",
    processing: "processingAt",
    shipped: "shippedAt",
    delivered: "deliveredAt",
    completed: "completedAt",
    cancelled: "cancelledAt",
    return_requested: "returnRequestedAt",
    returned: "returnedAt",
    refunded: "refundedAt",
  };
  return map[normalizeStatus(status)] || null;
}

function deriveOverallStatus(sellerFulfillment = {}) {
  const statuses = Object.values(sellerFulfillment).map((s) =>
    normalizeStatus(s?.status || "created")
  );
  if (!statuses.length) return "created";

  const all = (x) => statuses.every((s) => s === x);
  const any = (x) => statuses.some((s) => s === x);

  if (any("refunded")) return "refunded";
  if (any("returned")) return "returned";
  if (any("return_requested")) return "return_requested";

  if (all("completed")) return "completed";
  if (statuses.every((s) => s === "delivered" || s === "completed"))
    return "delivered";
  if (any("shipped")) return "shipped";
  if (any("processing")) return "processing";
  if (any("confirmed")) return "confirmed";

  if (all("cancelled")) return "cancelled";
  return "created";
}

/* ===============================
   Commission helpers (Minimum Safe Fix)
   - Snapshot commission onto invoice at the moment invoice is settled (paid)
   - Idempotent: only writes if missing
=============================== */

async function getDefaultCommissionRate() {
  // ✅ Supports both shapes:
  // 1) {_id:"default", settings:{global:{rateType, rate}}}
  // 2) {global:{rateType, rate}}  (legacy)
  const doc = await CommissionSettings.findOne(
    { _id: "default" },
    { projection: { settings: 1, global: 1, defaultRate: 1 } }
  );

  const rateTypeRaw =
    doc?.settings?.global?.rateType ??
    doc?.global?.rateType ??
    "percentage";

  const rateRaw =
    doc?.settings?.global?.rate ??
    doc?.global?.rate ??
    doc?.defaultRate ??
    0;

  const rateType = String(rateTypeRaw || "percentage").toLowerCase();
  const rate = Number(rateRaw);

  if (!Number.isFinite(rate) || rate < 0) return { rateType: "percentage", rate: 0 };
  return { rateType: rateType === "flat" ? "flat" : "percentage", rate };
}

function computeInvoiceBaseAmount(invoice) {
  // Prefer items sum (defensible), fallback to totalAmount
  const items = Array.isArray(invoice?.items) ? invoice.items : [];
  const itemsSum = items.reduce((sum, it) => {
    const price = Number(it?.price);
    const qty = Number(it?.quantity);
    if (!Number.isFinite(price) || !Number.isFinite(qty)) return sum;
    return sum + price * qty;
  }, 0);

  if (Number.isFinite(itemsSum) && itemsSum > 0) return itemsSum;

  const totalAmount = Number(invoice?.totalAmount);
  return Number.isFinite(totalAmount) ? totalAmount : 0;
}

/* ===============================
   COD Helpers (Merged Rules)
   ✅ Rule you finalized:
   - Delivered => Order paymentStatus becomes "paid" (collected)
   - Completed => Invoice status becomes "paid" (settled)
   ✅ FIX for payout queue:
   - Delivered/Completed MUST also update invoice orderStatus/deliveryStatus
=============================== */

function isCODOrder(order) {
  // ✅ We treat COD by paymentMethod primarily, but allow legacy paymentStatus="cod"
  const pm = String(order?.paymentMethod || "").toLowerCase();
  const ps = String(order?.paymentStatus || "").toLowerCase();
  return pm === "cod" || ps === "cod";
}

async function findLatestCodInvoiceForOrder(orderIdObj) {
  const oidObj = orderIdObj;
  const oidStr = String(orderIdObj);

  return await Invoices.findOne(
    {
      $and: [
        {
          $or: [
            { orderId: oidObj },
            { orderId: oidStr },
            { $expr: { $eq: [{ $toString: "$orderId" }, oidStr] } },
          ],
        },
        {
          $expr: {
            $eq: [{ $toLower: { $ifNull: ["$paymentMethod", ""] } }, "cod"],
          },
        },
      ],
    },
    {
      sort: { createdAt: -1, _id: -1 },
      // ✅ IMPORTANT: include what commission snapshot needs
      projection: {
        _id: 1,
        status: 1,
        paidAt: 1,
        paymentMethod: 1,
        paymentReference: 1,
        createdAt: 1,
        orderId: 1,
        orderStatus: 1,
        deliveryStatus: 1,
        commissionPayout: 1,
        // for commission compute
        totalAmount: 1,
        items: 1,
        // legacy+new fields
        commissionSnapshot: 1,
        commissionRate: 1,
        commissionRateType: 1,
        commissionBaseAmount: 1,
        commissionAmount: 1,
        commission: 1,
      },
    }
  );
}

async function writeInvoiceAudit({ invoiceId, orderId, from, to, actor, note }) {
  try {
    const iid = toObjectId(invoiceId);
    if (!iid) return;

    await InvoiceAuditLogs.insertOne({
      invoiceId: iid,
      orderId: toObjectId(orderId) || orderId || null,
      fromStatus: normalizeStatus(from),
      toStatus: normalizeStatus(to),
      note: safeString(note),
      actor: safeString(actor),
      createdAt: new Date(),
    });
  } catch (e) {
    console.warn("⚠️ invoiceAuditLogs insert failed:", e?.message || e);
  }
}

/**
 * DELIVERED → ORDER PAID (Collected)
 * - Requires COD invoice to exist (409 if missing)
 * - Updates ONLY order.paymentStatus => paid (idempotent)
 * - Does NOT mark invoice status paid here (per your rule)
 * ✅ FIX:
 * - Updates invoice.orderStatus + invoice.deliveryStatus to "delivered"
 */
async function applyCodCollectedAtDelivered({ order, actor, now, note }) {
  const latestCodInvoice = await findLatestCodInvoiceForOrder(order._id);

  if (!latestCodInvoice?._id) {
    return {
      ok: false,
      code: 409,
      message:
        "COD invoice not found for this order. Issue invoice first, then mark Delivered.",
    };
  }

  // Order: idempotent mark paid (CRITICAL)
  const curPs = normalizeStatus(order.paymentStatus || "");
  if (curPs !== "paid") {
    await Orders.updateOne(
      { _id: order._id },
      {
        $set: {
          paymentStatus: "paid",
          paidAt: now,
          paymentUpdatedAt: now,
          paymentUpdatedBy: actor,
          paymentNote: "COD collected at delivery (auto)",
        },
      }
    );
  }

  const codInvoice = latestCodInvoice;

  // Finance ledger: COD collected at delivery => move from clearing -> cash pool
  try {
    const orderIdStr = String(order?._id || "");
    const orderNumber = String(order?.orderNumber || "");
    const invoiceNumber = String(codInvoice?.invoiceNumber || codInvoice?.number || "");
    const sourceRef = invoiceNumber || orderNumber || orderIdStr || "COD-DELIVERED";

    const codAmount = safeNum(
      codInvoice?.total ??
        codInvoice?.grandTotal ??
        codInvoice?.payableTotal ??
        codInvoice?.amount ??
        order?.total ??
        order?.totalAmount ??
        0
    );

    if (codAmount > 0) {
      await postTransactionGroup(await getDB(), {
        transactionGroupId: `cod_delivered_${orderIdStr}`,
        postedAt: new Date(),
        sourceRef,
        category: "cod_marked_paid",
        note: "COD collected at delivery (Delivered). Move clearing -> cash pool.",
        legs: [
          // Increase cash pool
          { accountKey: "platform:cash_bank", dc: "credit", amount: codAmount, sourceRef },
          // Decrease clearing
          { accountKey: "platform:clearing", dc: "debit", amount: codAmount, sourceRef },
        ],
      });
    }
  } catch (e) {
    // Do NOT break order status update if finance posting fails
    console.error("Finance posting failed at COD Delivered", e);
  }

  // ✅ Invoice: mark delivery/order status to delivered (idempotent)
  // Do NOT touch invoice.status here.
  const invOrderStatus = normalizeStatus(latestCodInvoice.orderStatus || "");
  const invDeliveryStatus = normalizeStatus(latestCodInvoice.deliveryStatus || "");
  if (invOrderStatus !== "delivered" || invDeliveryStatus !== "delivered") {
    await Invoices.updateOne(
      { _id: latestCodInvoice._id },
      {
        $set: {
          orderStatus: "delivered",
          deliveryStatus: "delivered",
          updatedAt: now,
          updatedBy: actor,
        },
      }
    );
  }

  // Audit (invoice log as event marker; invoice status unchanged)
  writeInvoiceAudit({
    invoiceId: latestCodInvoice._id,
    orderId: order._id,
    from: normalizeStatus(latestCodInvoice.status || "issued"),
    to: normalizeStatus(latestCodInvoice.status || "issued"),
    actor,
    note: `Order delivered → COD collected (order paid only). ${safeString(note)}`,
  }).catch(() => {});

  return { ok: true, invoiceId: latestCodInvoice._id };
}

/**
 * COMPLETED → INVOICE PAID (Settled)
 * - Requires COD invoice to exist (409 if missing)
 * - Updates invoice.status => paid (idempotent)
 * - Ensures order remains paid (safety)
 * ✅ FIX:
 * - Updates invoice.orderStatus + invoice.deliveryStatus to "completed"
 * - Ensures invoice.commissionPayout.status exists as "pending" (unless already processing/paid)
 * ✅ NEW:
 * - Snapshots commission to invoice IF missing (idempotent)
 *   Writes BOTH:
 *   - commissionSnapshot (your earlier snapshot)
 *   - commission {rateType, rate, baseAmount, amount} (what adminCommissionRoutes reads)
 */
async function applyCodInvoicePaidAtCompleted({ order, actor, now, note, paymentReference }) {
  const latestCodInvoice = await findLatestCodInvoiceForOrder(order._id);

  if (!latestCodInvoice?._id) {
    return {
      ok: false,
      code: 409,
      message: "COD invoice missing. Cannot complete.",
    };
  }

  const invFrom = normalizeStatus(latestCodInvoice.status || "issued");
  const payoutStatus = normalizeStatus(
    latestCodInvoice?.commissionPayout?.status || "pending"
  );

  // ✅ Commission snapshot (idempotent): write once if missing
  const hasCommission =
    !!latestCodInvoice?.commissionSnapshot ||
    Number.isFinite(Number(latestCodInvoice?.commissionAmount)) ||
    Number.isFinite(Number(latestCodInvoice?.commission?.amount)) ||
    Number.isFinite(Number(latestCodInvoice?.commission?.rate));

  let commissionPatch = null;

  if (!hasCommission) {
    const { rateType, rate } = await getDefaultCommissionRate();
    const baseAmount = computeInvoiceBaseAmount(latestCodInvoice);

    let commissionAmount = 0;
    if (rateType === "flat") {
      commissionAmount = Number.isFinite(rate) ? rate : 0;
    } else {
      commissionAmount =
        baseAmount * (Number.isFinite(rate) ? rate : 0) / 100;
    }

    // Normalize
    commissionAmount = Math.max(0, Math.round(commissionAmount * 100) / 100);

    commissionPatch = {
      // ✅ keep your snapshot (legacy-safe)
      commissionSnapshot: {
        rateType,
        rate,
        baseAmount,
        commissionAmount,
        computedAt: now,
        computedBy: actor,
        source: "admin_order_completed_auto",
      },

      // ✅ REQUIRED for adminCommissionRoutes.js (reads commission.rate/commission.amount)
      commission: {
        rateType,
        rate,
        baseAmount,
        amount: commissionAmount,
        computedAt: now,
        computedBy: actor,
        source: "admin_order_completed_auto",
      },

      // Extra flat fields for listing pipelines/UI (safe, optional)
      commissionRate: rate,
      commissionRateType: rateType,
      commissionBaseAmount: baseAmount,
      commissionAmount: commissionAmount,
    };
  }

  const setPatch = {
    // ✅ Ensure completed flags for settlement eligibility
    orderStatus: "completed",
    deliveryStatus: "completed",
    updatedAt: now,
    updatedBy: actor,
    ...(commissionPatch || {}),
  };

  if (paymentReference) {
    setPatch.paymentReference = safeString(paymentReference);
  }

  // ✅ Ensure commissionPayout.status exists for queue/batching
  // Do not downgrade processing/paid
  if (payoutStatus !== "processing" && payoutStatus !== "paid") {
    setPatch["commissionPayout.status"] = payoutStatus || "pending";
    setPatch["commissionPayout.updatedAt"] = now;
    setPatch["commissionPayout.updatedBy"] = actor;
  }

  const codInvoice = latestCodInvoice;

  if (invFrom !== "paid") {
    setPatch.status = "paid";
    setPatch.paidAt = now;

    await Invoices.updateOne(
      { _id: latestCodInvoice._id },
      {
        $set: setPatch,
        $push: {
          paymentHistory: {
            from: invFrom,
            to: "paid",
            at: now,
            actor,
            note: [safeString(note), paymentReference ? `Ref: ${safeString(paymentReference)}` : ""]
              .filter(Boolean)
              .join(" ")
              .trim(),
            source: "admin_order_completed_auto",
          },
        },
      }
    );

    writeInvoiceAudit({
      invoiceId: latestCodInvoice._id,
      orderId: order._id,
      from: invFrom,
      to: "paid",
      actor,
      note: `Order completed → invoice settled. ${[safeString(note), paymentReference ? `Ref: ${safeString(paymentReference)}` : ""]
        .filter(Boolean)
        .join(" ")
        .trim()}`,
    }).catch(() => {});
  } else {
    // already paid => still ensure completed flags + payout status shape + commission snapshot
    await Invoices.updateOne(
      { _id: latestCodInvoice._id },
      { $set: setPatch }
    );
  }

  // Finance ledger: allocate collected cash into commission + seller earnings
  try {
    const orderIdStr = String(order?._id || "");
    const invoiceIdStr = String(codInvoice?._id || "");
    const orderNumber = String(order?.orderNumber || "");
    const invoiceNumber = String(codInvoice?.invoiceNumber || codInvoice?.number || "");
    const sourceRef = invoiceNumber || orderNumber || invoiceIdStr || "COD-COMPLETED";

    const total = safeNum(
      codInvoice?.total ??
        codInvoice?.grandTotal ??
        codInvoice?.payableTotal ??
        codInvoice?.amount ??
        0
    );

    const commissionAmount = safeNum(
      codInvoice?.commission?.amount ??
        codInvoice?.commissionAmount ??
        codInvoice?.commission ??
        0
    );

    // Seller identity is sometimes present on invoice; if missing we only book commission now.
    const sellerIdStr = String(codInvoice?.sellerId || "");
    const sellerKey = sellerIdStr ? `seller:${sellerIdStr}` : null;

    // If seller leg is possible, allocate sellerNet = total - commission (bounded).
    const sellerNet = sellerKey ? Math.max(0, total - commissionAmount) : 0;

    // Build legs: always book commission if >0; book seller leg only when sellerId is known.
    const legs = [];
    let allocated = 0;

    if (commissionAmount > 0) {
      legs.push({ accountKey: "platform:commission", dc: "credit", amount: commissionAmount, sourceRef });
      allocated += commissionAmount;
    }

    if (sellerKey && sellerNet > 0) {
      legs.push({ accountKey: sellerKey, dc: "credit", amount: sellerNet, sourceRef, sellerId: sellerIdStr });
      allocated += sellerNet;
    }

    // Offset: reduce cash pool by allocated amount (so cash pool represents “unallocated COD cash”)
    if (allocated > 0) {
      legs.unshift({ accountKey: "platform:cash_bank", dc: "debit", amount: allocated, sourceRef });

      await postTransactionGroup(await getDB(), {
        transactionGroupId: `cod_completed_${orderIdStr}_${invoiceIdStr}`,
        postedAt: new Date(),
        sourceRef,
        category: "cod_marked_paid",
        note: "COD Completed allocation: cash pool -> commission (+ seller earnings when sellerId known).",
        legs,
      });
    }
  } catch (e) {
    console.error("Finance posting failed at COD Completed", e);
  }

  // Safety: ensure order remains paid
  const orderPaymentPatch = {
    paymentStatus: "paid",
    paidAt: now,
    paymentUpdatedAt: now,
    paymentUpdatedBy: actor,
  };

  if (paymentReference) {
    orderPaymentPatch.paymentReference = safeString(paymentReference);
  }

  if (normalizeStatus(order.paymentStatus) !== "paid") {
    await Orders.updateOne({ _id: order._id }, { $set: orderPaymentPatch });
  }

  return { ok: true, invoiceId: latestCodInvoice._id };
}

/* ===============================
   Payout Queue Safety Helpers (Minimum Safe Fix)
=============================== */

function isDeliveredOrCompleted(status) {
  const s = normalizeStatus(status);
  return s === "delivered" || s === "completed";
}

async function syncInvoiceSnapshotsForOrder({ orderIdObj, nextStatus, actor, now }) {
  const st = normalizeStatus(nextStatus);
  if (!isDeliveredOrCompleted(st)) return;

  const oidStr = String(orderIdObj);

  await Invoices.updateMany(
    {
      $or: [
        { orderId: orderIdObj },
        { orderId: oidStr },
        { $expr: { $eq: [{ $toString: "$orderId" }, oidStr] } },
      ],
    },
    {
      $set: {
        orderStatus: st,
        deliveryStatus: st,
        updatedAt: now,
        updatedBy: actor,
      },
    }
  );
}

async function enforcePaidInvoiceCompletionInvariant({ orderIdObj, actor, now }) {
  const oidStr = String(orderIdObj);

  await Invoices.updateMany(
    {
      $and: [
        {
          $or: [
            { orderId: orderIdObj },
            { orderId: oidStr },
            { $expr: { $eq: [{ $toString: "$orderId" }, oidStr] } },
          ],
        },
        {
          $or: [{ status: "paid" }, { paidAt: { $ne: null } }],
        },
        {
          orderStatus: { $nin: ["delivered", "completed"] },
        },
        {
          deliveryStatus: { $nin: ["delivered", "completed"] },
        },
      ],
    },
    {
      $set: {
        orderStatus: "completed",
        deliveryStatus: "completed",
        updatedAt: now,
        updatedBy: actor,
      },
    }
  );
}

/* ===============================
   Transition hardening + audit + notify
=============================== */

// 🔒 Admin can only mark these
const ADMIN_ALLOWED_TARGETS = new Set(["delivered", "completed"]);

// 🔒 Lock admin transitions (only shipped→delivered→completed)
function canAdminTransition(from, to) {
  const f = normalizeStatus(from);
  const t = normalizeStatus(to);
  if (t === "delivered") return f === "shipped";
  if (t === "completed") return f === "delivered";
  return false;
}

function allSellerSegmentsAtLeast(map, allowedSet) {
  return Object.values(map || {}).every((seg) =>
    allowedSet.has(normalizeStatus(seg?.status || "created"))
  );
}

async function writeAudit({ orderId, orderNumber, from, to, actor, note }) {
  try {
    await OrderAuditLogs.insertOne({
      orderId,
      orderNumber: orderNumber || null,
      fromStatus: normalizeStatus(from),
      toStatus: normalizeStatus(to),
      note: safeString(note),
      actor: safeString(actor),
      createdAt: new Date(),
    });
  } catch (e) {
    console.warn("⚠️ orderAuditLogs insert failed:", e?.message || e);
  }
}

async function notifyCustomer(order, nextStatus) {
  try {
    const uid = toObjectId(order?.userId);
    if (!uid) return;

    const st = normalizeStatus(nextStatus);
    const title =
      st === "delivered"
        ? "Your order has been delivered"
        : st === "completed"
        ? "Your order is completed"
        : "Order status updated";

    await enqueueNotification("customer", {
      customerId: uid,
      orderId: order._id,
      orderNumber: order.orderNumber || null,
      type: "order_status",
      status: st,
      title,
      body: `Order status updated to ${st}.`,
      link: "/orders",
      meta: { orderId: String(order._id || ""), status: st },
    });
  } catch (e) {
    console.warn("⚠️ customerNotifications insert failed:", e?.message || e);
  }
}

/* ===================================================
   CORE HANDLERS
=================================================== */

async function handleAdminOrdersList(req, res) {
  try {
    const {
      page = "1",
      limit = "20",
      status = "all",
      paymentStatus = "all", // paid | pending | failed | refunded | cod | all
      search = "",
      from = "",
      to = "",
      sellerId = "",
      sortBy = "createdAt",
      sortDir = "desc",
    } = req.query;

    const pageNum = Math.max(1, Number(page) || 1);
    const limitNum = Math.min(100, Math.max(1, Number(limit) || 20));
    const skip = (pageNum - 1) * limitNum;

    const match = {};

    // status
    if (normalizeStatus(status) !== "all") {
      match.status = normalizeStatus(status);
    }

    // date range (createdAt)
    const start = parseDateStart(from);
    const end = parseDateEnd(to);
    if (start || end) {
      match.createdAt = {};
      if (start) match.createdAt.$gte = start;
      if (end) match.createdAt.$lte = end;
    }

    // seller filter (items.sellerId is string)
    if (String(sellerId).trim()) {
      match["items.sellerId"] = String(sellerId).trim();
    }

    // search
    const q = String(search || "").trim();
    if (q) {
      const rx = new RegExp(escapeRegex(q), "i");
      const oid = toObjectId(q);

      match.$or = [
        ...(oid ? [{ _id: oid }] : []),
        { orderNumber: rx },
        { customerName: rx },
        { customerEmail: rx },
        { customerPhone: rx },
        { "shippingAddress.fullName": rx },
        { "shippingAddress.name": rx },
        { "shippingAddress.phone": rx },
        { "shippingAddress.email": rx },
      ];
    }

    const sort = mapSort(sortBy, sortDir);
    const paymentFilter = normalizeStatus(paymentStatus || "all");

    const pipeline = [
      { $match: match },

      // Normalize fields
      {
        $addFields: {
          _orderIdObj: "$_id",
          _orderIdStr: { $toString: "$_id" },

          _orderPaymentMethodLower: {
            $toLower: { $ifNull: ["$paymentMethod", ""] },
          },
          _orderPaymentStatusLower: {
            $toLower: { $ifNull: ["$paymentStatus", ""] },
          },

          _userIdObj: {
            $convert: {
              input: "$userId",
              to: "objectId",
              onError: null,
              onNull: null,
            },
          },

          _totalAmount: {
            $convert: {
              input: { $ifNull: ["$totals.grandTotal", 0] },
              to: "double",
              onError: 0,
              onNull: 0,
            },
          },
        },
      },

      // Lookup latest COD invoice for this order
      {
        $lookup: {
          from: "invoices",
          let: { oidObj: "$_orderIdObj", oidStr: "$_orderIdStr" },
          pipeline: [
            {
              $match: {
                $expr: {
                  $or: [
                    { $eq: ["$orderId", "$$oidObj"] },
                    { $eq: ["$orderId", "$$oidStr"] },
                    { $eq: [{ $toString: "$orderId" }, "$$oidStr"] },
                  ],
                },
              },
            },
            {
              $addFields: {
                _invPaymentMethodLower: {
                  $toLower: { $ifNull: ["$paymentMethod", ""] },
                },
              },
            },
            { $match: { _invPaymentMethodLower: "cod" } },
            { $sort: { createdAt: -1, _id: -1 } },
            { $limit: 1 },
            {
              $project: {
                _id: 1,
                status: 1,
                paymentMethod: 1,
                paidAt: 1,
                paymentReference: 1,
                createdAt: 1,
              },
            },
          ],
          as: "_latestCodInvoice",
        },
      },

      // Compute effective payment status (COD => invoice drives)
      { $addFields: { _codInvoice: { $arrayElemAt: ["$_latestCodInvoice", 0] } } },
      {
        $addFields: {
          _isCOD: {
            $or: [
              { $eq: ["$_orderPaymentMethodLower", "cod"] },
              { $eq: ["$_orderPaymentStatusLower", "cod"] },
            ],
          },
          _invoiceStatusLower: {
            $toLower: { $ifNull: ["$_codInvoice.status", ""] },
          },
        },
      },
      {
        $addFields: {
          _paymentStatusEffective: {
            $cond: [
              "$_isCOD",
              {
                $cond: [{ $eq: ["$_invoiceStatusLower", "paid"] }, "paid", "pending"],
              },
              "$_orderPaymentStatusLower",
            ],
          },
        },
      },

      // Apply paymentStatus filter AFTER effective status exists
      ...(paymentFilter !== "all"
        ? [
            {
              $match:
                paymentFilter === "cod"
                  ? { $expr: { $eq: ["$_isCOD", true] } }
                  : { $expr: { $eq: ["$_paymentStatusEffective", paymentFilter] } },
            },
          ]
        : []),

      // User lookup
      {
        $lookup: {
          from: "users",
          localField: "_userIdObj",
          foreignField: "_id",
          as: "user",
        },
      },
      { $unwind: { path: "$user", preserveNullAndEmptyArrays: true } },

      // Display fields
      {
        $addFields: {
          _itemsCount: { $cond: [{ $isArray: "$items" }, { $size: "$items" }, 0] },
          _customerName: {
            $ifNull: [
              "$customerName",
              { $ifNull: ["$shippingAddress.fullName", "$shippingAddress.name"] },
            ],
          },
          _customerEmail: { $ifNull: ["$customerEmail", "$user.email"] },
          _customerPhone: { $ifNull: ["$customerPhone", "$shippingAddress.phone"] },
        },
      },

      // Facet pagination + summary
      {
        $facet: {
          data: [
            { $sort: sort },
            { $skip: skip },
            { $limit: limitNum },
            {
              $project: {
                _id: 1,
                orderNumber: 1,
                status: 1,
                paymentMethod: 1,

                // ✅ keep old field but also include effective explicitly
                paymentStatus: "$_paymentStatusEffective",
                paymentStatusEffective: "$_paymentStatusEffective",

                createdAt: 1,
                totalAmount: "$_totalAmount",
                totals: 1,
                itemsCount: "$_itemsCount",
                customerName: "$_customerName",
                customerEmail: "$_customerEmail",
                customerPhone: "$_customerPhone",
                shippingAddress: 1,

                codInvoiceStatus: { $ifNull: ["$_codInvoice.status", null] },
                codInvoiceId: { $ifNull: ["$_codInvoice._id", null] },
                codInvoicePaidAt: { $ifNull: ["$_codInvoice.paidAt", null] },
                codInvoicePaymentReference: {
                  $ifNull: ["$_codInvoice.paymentReference", null],
                },
              },
            },
          ],
          totalCount: [{ $count: "count" }],
          summary: [
            {
              $group: {
                _id: null,
                totalOrders: { $sum: 1 },
                totalAmount: { $sum: "$_totalAmount" },
                paidCount: {
                  $sum: {
                    $cond: [{ $eq: ["$_paymentStatusEffective", "paid"] }, 1, 0],
                  },
                },
              },
            },
          ],
        },
      },
    ];

    const agg = await Orders.aggregate(pipeline, { allowDiskUse: true }).toArray();
    const first = agg?.[0] || {};
    const orders = first.data || [];
    const total = first.totalCount?.[0]?.count || 0;
    const summaryRow = first.summary?.[0] || null;

    return res.json({
      success: true,
      orders,
      page: pageNum,
      limit: limitNum,
      total,
      totalPages: Math.max(1, Math.ceil(total / limitNum)),
      summary: summaryRow
        ? {
            totalOrders: summaryRow.totalOrders || 0,
            totalAmount: summaryRow.totalAmount || 0,
            paidCount: summaryRow.paidCount || 0,
          }
        : { totalOrders: total, totalAmount: 0, paidCount: 0 },
    });
  } catch (err) {
    console.error("❌ GET /api/admin/orders error:", err);
    return res.status(500).json({ message: "Failed to load orders" });
  }
}

async function handleAdminOrderDetail(req, res) {
  try {
    const oid = toObjectId(req.params.id);
    if (!oid) return res.status(400).json({ message: "Invalid order id" });

    const order = await Orders.findOne({ _id: oid });
    if (!order) return res.status(404).json({ message: "Order not found" });

    const userId = toObjectId(order.userId);
    const user = userId
      ? await Users.findOne(
          { _id: userId },
          { projection: { password: 0, resetToken: 0, resetTokenExpiry: 0 } }
        )
      : null;

    const latestCodInvoice = isCODOrder(order)
      ? await findLatestCodInvoiceForOrder(order._id)
      : null;

    const pm = String(order.paymentMethod || "").toLowerCase();
    const ps = String(order.paymentStatus || "").toLowerCase();
    const isCOD = pm === "cod" || ps === "cod";
    const invStatus = String(latestCodInvoice?.status || "").toLowerCase();

    const paymentStatusEffective = isCOD ? (invStatus === "paid" ? "paid" : "pending") : ps;

    return res.json({
      success: true,
      order: {
        ...order,
        paymentStatusEffective,
        codInvoice: latestCodInvoice || null,
      },
      user,
    });
  } catch (err) {
    console.error("❌ GET /api/admin/orders/:id error:", err);
    return res.status(500).json({ message: "Failed to fetch order" });
  }
}

/* ===================================================
   STATUS UPDATE
=================================================== */

async function applyAdminStatusUpdate({ req, res, orderId, nextStatusRaw, noteRaw }) {
  const oid = toObjectId(orderId);
  if (!oid) return res.status(400).json({ message: "Invalid order id" });

  const nextStatus = normalizeStatus(nextStatusRaw);
  const note = safeString(noteRaw || "");
  const paymentReference = safeString(req.body?.paymentReference || "");

  if (!nextStatus) return res.status(400).json({ message: "nextStatus is required" });

  // 🔒 Admin only delivered/completed here
  if (!ADMIN_ALLOWED_TARGETS.has(nextStatus)) {
    return res
      .status(400)
      .json({ message: "Admin can only mark Delivered or Completed" });
  }

  const order = await Orders.findOne({ _id: oid });
  if (!order) return res.status(404).json({ message: "Order not found" });

  const fromStatus = normalizeStatus(order.status);

  // 🔒 lock transitions (only shipped→delivered→completed)
  if (!canAdminTransition(fromStatus, nextStatus)) {
    return res
      .status(409)
      .json({ message: `Invalid transition: ${fromStatus} → ${nextStatus}` });
  }

  const now = new Date();
  const actor = getActorId(req);

  const sellerTarget = adminStatusToSellerStatus(nextStatus);

  const sellerFulfillment =
    order?.sellerFulfillment && typeof order.sellerFulfillment === "object"
      ? { ...order.sellerFulfillment }
      : {};

  if (!Object.keys(sellerFulfillment).length) {
    return res.status(409).json({ message: "sellerFulfillment missing — cannot update" });
  }

  // 🔐 Multi-seller guards
  if (
    sellerTarget === "delivered" &&
    !allSellerSegmentsAtLeast(
      sellerFulfillment,
      new Set(["shipped", "delivered", "completed"])
    )
  ) {
    return res.status(409).json({ message: "All sellers must be shipped before Delivered" });
  }

  if (
    sellerTarget === "completed" &&
    !allSellerSegmentsAtLeast(sellerFulfillment, new Set(["delivered", "completed"]))
  ) {
    return res.status(409).json({ message: "All sellers must be delivered before Completed" });
  }

  const updateSeg = (seg, toStatus) => {
    const to = normalizeStatus(toStatus);
    const out = seg && typeof seg === "object" ? { ...seg } : {};
    out.status = to;
    out.updatedAt = now;
    out.updatedBy = actor;
    out.timeline = out.timeline && typeof out.timeline === "object" ? { ...out.timeline } : {};
    const tsKey = timestampFieldForStatus(to);
    if (tsKey) out.timeline[tsKey] = now;
    return out;
  };

  // Delivered: shipped -> delivered
  if (sellerTarget === "delivered") {
    for (const sid of Object.keys(sellerFulfillment)) {
      const cur = normalizeStatus(sellerFulfillment[sid]?.status || "created");
      if (cur === "shipped")
        sellerFulfillment[sid] = updateSeg(sellerFulfillment[sid], "delivered");
    }
  }

  // Completed: delivered -> completed
  if (sellerTarget === "completed") {
    for (const sid of Object.keys(sellerFulfillment)) {
      const cur = normalizeStatus(sellerFulfillment[sid]?.status || "created");
      if (cur === "delivered")
        sellerFulfillment[sid] = updateSeg(sellerFulfillment[sid], "completed");
    }
  }

  const derived = deriveOverallStatus(sellerFulfillment);

  // ✅ COD RULES (Merged)
  const isCod = isCODOrder(order);

  if (nextStatus === "delivered" && isCod) {
    const codRes = await applyCodCollectedAtDelivered({ order, actor, now, note });
    if (!codRes.ok) {
      return res.status(codRes.code || 400).json({ message: codRes.message });
    }
  }

  if (nextStatus === "completed" && isCod) {
    const codRes = await applyCodInvoicePaidAtCompleted({
      order,
      actor,
      now,
      note,
      paymentReference,
    });
    if (!codRes.ok) {
      return res.status(codRes.code || 400).json({ message: codRes.message });
    }
  }

  // ✅ Race-safe update: only update if order status is still what we read
  const orderSet = {
    status: derived,
    sellerFulfillment,
    derivedStatus: derived, // optional debug
    updatedAt: now,
    adminStatusNote: note,
    adminStatusUpdatedAt: now,
    adminStatusUpdatedBy: actor,
  };

  const upd = await Orders.updateOne(
    { _id: oid, status: order.status },
    {
      $set: orderSet,
      $push: {
        adminStatusHistory: { from: fromStatus, to: nextStatus, note, actor, at: now },
      },
    }
  );

  if (!upd?.matchedCount) {
    return res.status(409).json({
      message: "Order status changed by another process. Refresh and try again.",
    });
  }

  // ✅ Minimum safe fix:
  await syncInvoiceSnapshotsForOrder({ orderIdObj: oid, nextStatus, actor, now });
  await enforcePaidInvoiceCompletionInvariant({ orderIdObj: oid, actor, now });

  const updated = await Orders.findOne({ _id: oid });

  // ✅ Audit + Notify (non-blocking)
  Promise.allSettled([
    writeAudit({
      orderId: oid,
      orderNumber: order?.orderNumber,
      from: fromStatus,
      to: nextStatus,
      actor,
      note,
    }),
    notifyCustomer(updated, nextStatus),
  ]).catch(() => {});

  return res.json({ success: true, order: updated });
}

// PATCH /api/admin/orders/:id/status  (PRIMARY)
router.patch(
  "/:id/status",
  authMiddleware,
  isActiveMiddleware,
  ensureAdminForOrders,
  async (req, res) => {
    try {
      return await applyAdminStatusUpdate({
        req,
        res,
        orderId: req.params.id,
        nextStatusRaw: req.body?.nextStatus,
        noteRaw: req.body?.note,
      });
    } catch (err) {
      console.error("❌ PATCH /api/admin/orders/:id/status error:", err);
      return res.status(500).json({ message: "Failed to update order status" });
    }
  }
);

// PATCH /api/admin/orders/:orderId/seller-payment-status (COD collection)
router.patch(
  "/:orderId/seller-payment-status",
  authMiddleware,
  isActiveMiddleware,
  ensureAdminForOrders,
  async (req, res) => {
    try {
      const orderId = toObjectId(req.params.orderId);
      const sellerIdStr = safeString(req.body?.sellerId);
      const paymentStatus = normalizePayStatus(req.body?.paymentStatus);

      if (!orderId || !sellerIdStr) {
        return res.status(400).json({ success: false, message: "Invalid id(s)" });
      }

      const order = await Orders.findOne({
        _id: orderId,
        items: { $elemMatch: { sellerId: sellerIdStr } },
      });

      if (!order) {
        return res.status(404).json({
          success: false,
          message: "Order not found for that seller",
        });
      }

      if (!isCODOrder(order)) {
        return res.status(400).json({
          success: false,
          message: "Only COD orders can be managed via sellerPayments.",
        });
      }

      const seg = order?.sellerFulfillment?.[sellerIdStr] || {};
      const sellerStatus = normalizeStatus(seg.status || "created");
      if (!["delivered", "completed"].includes(sellerStatus)) {
        return res.status(400).json({
          success: false,
          message:
            "Can mark COD paid only after Delivered or Completed for that seller.",
        });
      }

      const now = new Date();
      const actor = getActorId(req);
      const payPath = `sellerPayments.${sellerIdStr}`;
      const sellerPath = `sellerFulfillment.${sellerIdStr}`;

      await Orders.updateOne(
        { _id: orderId },
        {
          $set: {
            updatedAt: now,
            [`${payPath}.status`]: paymentStatus,
            [`${payPath}.paidAt`]: paymentStatus === "paid" ? now : null,
            [`${payPath}.paidBy`]: paymentStatus === "paid" ? actor : null,
            [`${payPath}.updatedAt`]: now,
            [`${sellerPath}.paymentStatus`]: paymentStatus,
            [`${sellerPath}.paidAt`]: paymentStatus === "paid" ? now : null,
            [`${sellerPath}.paidBy`]: paymentStatus === "paid" ? actor : null,
            [`${sellerPath}.updatedAt`]: now,
          },
        }
      );

      const after = await Orders.findOne({ _id: orderId });
      const overallPay = deriveOrderPaymentStatus(after);

      await Orders.updateOne(
        { _id: orderId },
        {
          $set: {
            paymentStatus: overallPay,
            paidAt: overallPay === "paid" ? after?.paidAt || now : null,
            paidBy: overallPay === "paid" ? after?.paidBy || actor : null,
            paymentUpdatedAt: now,
            paymentUpdatedBy: actor,
            updatedAt: now,
          },
        }
      );

      const statusForInvoices = normalizeStatus(after?.status || "");
      if (["delivered", "completed"].includes(statusForInvoices)) {
        await syncInvoiceSnapshotsForOrder({
          orderIdObj: orderId,
          nextStatus: statusForInvoices,
          actor,
          now,
        });
      }
      await enforcePaidInvoiceCompletionInvariant({ orderIdObj: orderId, actor, now });

      const final = await Orders.findOne({ _id: orderId });

      return res.json({
        success: true,
        message: "Seller payment status updated.",
        sellerId: sellerIdStr,
        sellerPaymentStatus:
          final?.sellerPayments?.[sellerIdStr]?.status || paymentStatus,
        sellerPaidAt: final?.sellerPayments?.[sellerIdStr]?.paidAt || null,
        paymentStatus: final?.paymentStatus || overallPay,
      });
    } catch (err) {
      console.error(
        "PATCH /api/admin/orders/:orderId/seller-payment-status error:",
        err
      );
      return res
        .status(500)
        .json({ success: false, message: "Failed to update payment status" });
    }
  }
);

// PATCH /api/admin/orders/:id  (FALLBACK - still uses same logic)
router.patch(
  "/:id",
  authMiddleware,
  isActiveMiddleware,
  ensureAdminForOrders,
  async (req, res) => {
    try {
      return await applyAdminStatusUpdate({
        req,
        res,
        orderId: req.params.id,
        nextStatusRaw: req.body?.status,
        noteRaw: req.body?.note,
      });
    } catch (err) {
      console.error("❌ PATCH /api/admin/orders/:id error:", err);
      return res.status(500).json({ message: "Failed to update order" });
    }
  }
);

/* ===================================================
   ROUTES (STRICT)
   Mounted at: /api/admin/orders
=================================================== */

// LIST: GET /api/admin/orders
router.get("/", authMiddleware, isActiveMiddleware, ensureAdminForOrders, handleAdminOrdersList);

// RETURNS: GET /api/admin/orders/returns
router.get(
  "/returns",
  authMiddleware,
  isActiveMiddleware,
  ensureAdminForOrders,
  async (req, res) => {
    try {
      const { status = "", q = "", page = "1", limit = "20" } = req.query;

      const pageNum = Math.max(1, parseInt(page, 10) || 1);
      const limitNum = Math.min(100, Math.max(5, parseInt(limit, 10) || 20));
      const skip = (pageNum - 1) * limitNum;

      const statusNorm = normalizeStatus(status);
      const hasStatus = !!statusNorm;
      const keyword = safeString(q);
      const rx = keyword ? new RegExp(escapeRegex(keyword), "i") : null;

      const match = {
        returnRequest: { $exists: true },
      };

      const pipeline = [
        { $match: match },
        ...(hasStatus
          ? [
              {
                $match: {
                  $or: [
                    { "returnRequest.status": statusNorm },
                    { "returnAdmin.status": statusNorm },
                  ],
                },
              },
            ]
          : []),
        ...(rx
          ? [
              {
                $match: {
                  $or: [
                    { orderNumber: rx },
                    { "shippingAddress.fullName": rx },
                    { "shippingAddress.name": rx },
                    { "shippingAddress.phone": rx },
                    { "returnRequest.reason": rx },
                  ],
                },
              },
            ]
          : []),
        { $sort: { "returnRequest.submittedAt": -1, createdAt: -1 } },
        {
          $facet: {
            rows: [
              { $skip: skip },
              { $limit: limitNum },
              {
                $project: {
                  _id: 1,
                  orderNumber: 1,
                  createdAt: 1,
                  status: 1,
                  paymentMethod: 1,
                  paymentStatus: 1,
                  totals: 1,
                  items: 1,
                  shippingAddress: 1,
                  returnRequest: 1,
                  returnAdmin: 1,
                },
              },
            ],
            meta: [{ $count: "total" }],
          },
        },
      ];

      const out = await Orders.aggregate(pipeline, { allowDiskUse: true }).toArray();
      const result = out?.[0] || {};
      const rows = result.rows || [];
      const total = result.meta?.[0]?.total || 0;
      const pages = Math.max(1, Math.ceil(total / limitNum));

      return res.json({
        success: true,
        returns: rows.map((o) => {
          const rr = o.returnRequest || {};
          const adminData = o.returnAdmin || null;
          const status = normalizeReturnStatus(rr.status || RETURN_STATUS.PENDING);
          const history = rr.history || [];
          const returnAdminPickup = adminData?.pickup || null;
          return {
            orderId: o._id,
            orderNumber: o.orderNumber || null,
            customerName:
              o.shippingAddress?.fullName ||
              o.shippingAddress?.name ||
              o.customerName ||
              "",
            status,
            reason: rr.reason || "",
            notes: rr.notes || "",
            createdAt: rr.submittedAt || o.createdAt || null,
            updatedAt: rr.updatedAt || null,
            history,
            amount: o.totals?.grandTotal ?? 0,
            returnAdmin: adminData
              ? {
                  ...adminData,
                  pickup: returnAdminPickup,
                }
              : null,
            returnAdminPickup,
          };
        }),
        pagination: { page: pageNum, pages, total, limit: limitNum },
      });
    } catch (err) {
      console.error("GET /api/admin/orders/returns error:", err);
      return res
        .status(500)
        .json({ success: false, message: "Failed to load return orders" });
    }
  }
);

router.patch(
  "/returns/:orderId/status",
  authMiddleware,
  isActiveMiddleware,
  ensureAdminForOrders,
  async (req, res) => {
    try {
      const orderId = toObjectId(req.params.orderId);
      const next = normalizeStatus(req.body?.status);
      const note = safeString(req.body?.note || "");

      if (!orderId) {
        return res.status(400).json({ success: false, message: "Invalid orderId" });
      }

      if (!ADMIN_RETURN_STATUSES.includes(next)) {
        return res.status(400).json({
          success: false,
          message: `Invalid return admin status. Allowed: ${ADMIN_RETURN_STATUSES.join(
            ", "
          )}`,
        });
      }

      const order = await Orders.findOne({ _id: orderId, returnRequest: { $exists: true } });
      if (!order) {
        return res.status(404).json({ success: false, message: "Return not found" });
      }

      const rrStatus = normalizeStatus(order?.returnRequest?.status);
      if (next !== "cancelled" && rrStatus !== "approved_awaiting_pickup") {
        return res.status(400).json({
          success: false,
          message:
            "Admin return workflow can proceed only after seller approval (approved_awaiting_pickup).",
        });
      }

      const currentAdmin = getAdminReturnStatus(order);
      if (!canTransitionAdminReturn(currentAdmin, next)) {
        return res.status(400).json({
          success: false,
          message: `Invalid transition from "${currentAdmin || "none"}" → "${next}".`,
          allowedNext: ADMIN_RETURN_NEXT[currentAdmin || null] || [],
        });
      }

      const now = new Date();
      const actor = getActorId(req);

      const patch = {
        $set: {
          updatedAt: now,
          "returnAdmin.status": next,
          "returnAdmin.updatedAt": now,
          "returnAdmin.updatedBy": actor,
        },
        $push: {
          "returnRequest.history": {
            status: `admin_${next}`,
            at: now,
            ...(note ? { note } : {}),
            actor,
          },
        },
      };

      if (note) patch.$set["returnAdmin.note"] = note;

      if (next === "pickup_scheduled") {
        const courier = safeString(req.body?.pickup?.courier || req.body?.courier || "");
        const trackingNumber = safeString(
          req.body?.pickup?.trackingNumber || req.body?.trackingNumber || ""
        );
        const scheduledAt =
          asDateOrNull(req.body?.pickup?.scheduledAt) || asDateOrNull(req.body?.scheduledAt) || now;

        if (!courier && !scheduledAt) {
          return res.status(400).json({
            success: false,
            message: "pickup_scheduled requires pickup.courier and/or pickup.scheduledAt.",
          });
        }

        patch.$set["returnAdmin.pickup"] = {
          courier: courier || null,
          trackingNumber: trackingNumber || null,
          scheduledAt,
          note: note || null,
        };
      }

      if (next === "picked_up") {
        patch.$set["returnAdmin.pickedUpAt"] = now;
      }

      if (next === "received_at_hub") {
        patch.$set["returnAdmin.receivedAt"] = now;
        patch.$set["status"] = "returned";
        patch.$set["returnedAt"] = now;
      }

      if (next === "refunded") {
        const refundMethod = safeString(
          req.body?.refund?.method || req.body?.refundMethod || ""
        );
        const refundRef = safeString(req.body?.refund?.ref || req.body?.refundRef || "");
        const refundNote = safeString(req.body?.refund?.note || "");
        const refundAmountRaw = req.body?.refund?.amount ?? req.body?.refundAmount;

        const refundAmount =
          refundAmountRaw === undefined || refundAmountRaw === null
            ? null
            : Number(refundAmountRaw);

        patch.$set["returnAdmin.refundedAt"] = now;
        patch.$set["returnAdmin.refund"] = {
          method: refundMethod || null,
          amount: Number.isFinite(refundAmount) ? refundAmount : null,
          ref: refundRef || null,
          note: refundNote || null,
        };

        patch.$set["status"] = "refunded";
        patch.$set["refundedAt"] = now;
      }

      if (next === "cancelled") {
        patch.$set["returnAdmin.cancelledAt"] = now;
      }

      await Orders.updateOne({ _id: orderId }, patch);
      let finalOrder = await Orders.findOne({ _id: orderId });
      let autoRefunded = false;

      if (next === "received_at_hub" && shouldAutoRefundReturn(finalOrder)) {
        try {
          finalOrder = await autoRefundReturn(finalOrder, actor);
          autoRefunded = true;
        } catch (err) {
          console.error("Auto refund after receipt failed:", err);
        }
      }

      const responseMessage = autoRefunded
        ? "Return received and refunded automatically"
        : `Admin return status updated: ${finalOrder?.returnAdmin?.status || next}`;

      return res.json({
        success: true,
        message: responseMessage,
        order: finalOrder,
        returnRequest: finalOrder?.returnRequest || null,
        returnAdmin: finalOrder?.returnAdmin || null,
      });
    } catch (err) {
      console.error("PATCH /api/admin/orders/returns/:orderId/status error:", err);
      return res
        .status(500)
        .json({ success: false, message: "Failed to update return status" });
    }
  }
);

// RETURNS DECISION: PATCH /api/admin/orders/returns/:orderId/decision
router.patch(
  "/returns/:orderId/decision",
  authMiddleware,
  isActiveMiddleware,
  ensureAdminForOrders,
  async (req, res) => {
    try {
      const orderId = toObjectId(req.params.orderId);
      const decision = safeString(req.body?.decision).toLowerCase();
      const nextStatus =
        decision === "approved"
          ? "approved_awaiting_pickup"
          : decision === "under_review"
          ? "under_review"
          : "rejected";
      const note = safeString(req.body?.note, 1000);
      const actor = getActorId(req);

      if (!orderId) {
        return res
          .status(400)
          .json({ success: false, message: "Invalid orderId" });
      }
      if (!["approved", "rejected", "under_review"].includes(decision)) {
        return res.status(400).json({
          success: false,
          message:
            "decision must be approved, rejected, or under_review",
        });
      }

      const order = await Orders.findOne({
        _id: orderId,
        returnRequest: { $exists: true },
      });
      if (!order) {
        return res
          .status(404)
          .json({ success: false, message: "Return not found" });
      }

      const currentStatus = normalizeStatus(
        order.returnRequest?.status || RETURN_STATUS.PENDING
      );
      if (
        !canTransitionReturnStatus(
          currentStatus,
          nextStatus,
          "admin"
        )
      ) {
        return res.status(409).json({
          success: false,
          message: `Cannot move return ${currentStatus || "unknown"} → ${nextStatus} as admin`,
        });
      }

      const now = new Date();
      const historyEntry = {
        status: nextStatus,
        at: now,
        note,
        actor,
      };

      await Orders.updateOne(
        { _id: orderId },
        {
          $set: {
            "returnRequest.status": nextStatus,
            "returnRequest.decidedAt":
              decision === "under_review" ? null : now,
            "returnRequest.updatedAt": now,
            "returnRequest.decidedBy": actor,
            "returnRequest.adminOverride": true,
            "returnRequest.adminNote": note || "",
          },
          $push: { "returnRequest.history": historyEntry },
        }
      );

      const updated = await Orders.findOne({ _id: orderId });
      return res.json({
        success: true,
        message:
          decision === "approved"
            ? "Return approved (awaiting pickup)"
            : decision === "under_review"
            ? "Return set to under review"
            : "Return rejected",
        returnRequest: updated?.returnRequest || null,
        order: updated,
      });
    } catch (err) {
      console.error("PATCH /api/admin/orders/returns/:orderId/decision error:", err);
      return res
        .status(500)
        .json({ success: false, message: "Failed to update return order" });
    }
  }
);

  // RETURNS REFUND: PATCH /api/admin/orders/returns/:orderId/refund
  router.patch(
    "/returns/:orderId/refund",
    authMiddleware,
    isActiveMiddleware,
    ensureAdminForOrders,
    async (req, res) => {
      try {
        const orderId = toObjectId(req.params.orderId);
        if (!orderId) {
          return res
            .status(400)
            .json({ success: false, message: "Invalid orderId" });
        }

        const order = await Orders.findOne({
          _id: orderId,
          returnRequest: { $exists: true },
        });
        if (!order) {
          return res
            .status(404)
            .json({ success: false, message: "Return not found" });
        }

        const currentStatus = normalizeStatus(
          order.returnRequest?.status || RETURN_STATUS.PENDING
        );
        if (
          !canTransitionReturnStatus(
            currentStatus,
            RETURN_STATUS.REFUNDED,
            "admin"
          )
        ) {
          return res.status(409).json({
            success: false,
            message: `Return must be ${RETURN_STATUS.RECEIVED_BY_SELLER} before refund.`,
          });
        }

        const now = new Date();
        const note = safeString(req.body?.note || "");
        const refundMethod = safeString(req.body?.method || req.body?.refundMethod || "wallet");
        const refundRef = safeString(req.body?.ref || req.body?.refundRef || "");
        const refundAmountRaw = req.body?.amount ?? req.body?.refundAmount;
        const refundAmount = Number.isFinite(Number(refundAmountRaw))
          ? Number(refundAmountRaw)
          : order.returnAdmin?.refund?.amount ??
            order.returnRequest?.refundAmount ??
            order.totals?.grandTotal ??
            0;

        const historyEntry = {
          status: RETURN_STATUS.REFUNDED,
          at: now,
          note: note || `Refund ${refundMethod}`,
          actor: getActorId(req),
        };

        const patch = {
          $set: {
            "returnRequest.status": RETURN_STATUS.REFUNDED,
            "returnRequest.updatedAt": now,
            "returnAdmin.status": RETURN_STATUS.REFUNDED,
            "returnAdmin.updatedAt": now,
            "returnAdmin.updatedBy": getActorId(req),
            "returnAdmin.refundedAt": now,
            "returnAdmin.refund": {
              method: refundMethod || null,
              amount: refundAmount,
              ref: refundRef || null,
              note: note || null,
            },
            status: "refunded",
            refundedAt: now,
          },
          $push: {
            "returnRequest.history": historyEntry,
          },
        };

        await Orders.updateOne({ _id: orderId }, patch);
        const updated = await Orders.findOne({ _id: orderId });

        return res.json({
          success: true,
          message: "Return refunded",
          order: updated,
          returnRequest: updated?.returnRequest || null,
          returnAdmin: updated?.returnAdmin || null,
        });
      } catch (err) {
        console.error("PATCH /api/admin/orders/returns/:orderId/refund error:", err);
        return res
          .status(500)
          .json({ success: false, message: "Failed to refund return" });
      }
    }
  );

  // RETURNS BOOK PICKUP: POST /api/admin/orders/returns/:orderId/schedule-pickup
  router.post(
  "/returns/:orderId/schedule-pickup",
  authMiddleware,
  isActiveMiddleware,
  ensureAdminForOrders,
  async (req, res) => {
    try {
      const orderId = toObjectId(req.params.orderId);
      if (!orderId) {
        return res
          .status(400)
          .json({ success: false, message: "Invalid orderId" });
      }

      const order = await Orders.findOne({ _id: orderId });
      if (!order || !order.returnRequest) {
        return res
          .status(404)
          .json({ success: false, message: "Return order not found" });
      }

      const existingPickup = order.returnAdmin?.pickup || {};
      if (safeString(existingPickup.trackingNumber)) {
        return res.json({
          success: true,
          message: "Return pickup already booked",
          returnRequest: order.returnRequest,
          returnAdmin: order.returnAdmin,
          courier: safeString(existingPickup.courier),
          trackingNumber: safeString(existingPickup.trackingNumber),
          shipmentId: safeString(existingPickup.shipmentId),
          bookingReference: safeString(existingPickup.bookingReference),
          partner: safeString(existingPickup.partner),
          scheduledAt: existingPickup.scheduledAt || null,
        });
      }

      const sellerIdOverride = safeString(req.body?.sellerId);
      const sellerId = getReturnSellerId(order) || sellerIdOverride;
      if (!sellerId) {
        return res.status(400).json({
          success: false,
          message: "Unable to determine seller for the return",
        });
      }

      const returnId =
        order?.returnRequest?._id ||
        order?.returnId ||
        order?.returnReferenceId ||
        order?.returnAdmin?.returnId ||
        null;

      const result = await bookReturnShipment({
        Returns,
        ReturnShipments,
        Orders,
        Users,
        orderId,
        returnId,
        sellerIdStr: sellerId,
        actor: { kind: "admin", id: getActorId(req) },
        note: safeString(req.body?.note || "Return pickup booked by admin"),
      });

      return res.json({
        success: true,
        message: "Return pickup booked with EverestX",
        order: result.order,
        returnRequest: result.order?.returnRequest || order.returnRequest,
        returnAdmin: result.order?.returnAdmin || order.returnAdmin,
        courier: result.courier,
        trackingNumber: result.trackingNumber,
        shipmentId: result.shipmentId,
        bookingReference: result.bookingReference,
        partner: result.partner,
        scheduledAt: result.scheduledAt,
      });
    } catch (err) {
      console.error(
        "POST /api/admin/orders/returns/:orderId/schedule-pickup error:",
        err
      );
      return res.status(500).json({
        success: false,
        message: err?.message || "Failed to schedule return pickup",
      });
    }
  }
);

// Retry shipping booking for a seller segment (admin-only)
router.post(
  "/:orderId/sellers/:sellerId/retry-shipping",
  authMiddleware,
  isActiveMiddleware,
  ensureAdminForOrders,
  async (req, res) => {
    try {
      const orderId = toObjectId(req.params.orderId);
      const sellerId = String(req.params.sellerId || "").trim();
      if (!orderId || !sellerId) {
        return res
          .status(400)
          .json({ success: false, message: "Invalid orderId/sellerId" });
      }

      const order = await Orders.findOne({ _id: orderId });
      if (!order) {
        return res
          .status(404)
          .json({ success: false, message: "Order not found" });
      }

      const seg = order?.sellerFulfillment?.[sellerId] || null;
      if (!seg) {
        return res
          .status(404)
          .json({ success: false, message: "Seller segment not found" });
      }

      const status = normalizeStatus(seg.status);
      if (status !== "ready_to_ship") {
        return res.status(400).json({
          success: false,
          message: "Retry allowed only when seller status is ready_to_ship",
        });
      }

      const shipping = seg.shipping || {};
      const bookingState = normalizeStatus(shipping.bookingState);
      const trackingNumber = safeString(shipping.trackingNumber);

      if (trackingNumber || bookingState === "booked") {
        return res.json({
          success: true,
          message: "Shipping already booked for this seller segment.",
          alreadyBooked: true,
        });
      }

      const MIN_GAP_MINUTES = 10;
      const lastAttemptAt = shipping.lastBookingAttemptAt
        ? new Date(shipping.lastBookingAttemptAt)
        : null;

      if (
        lastAttemptAt &&
        !Number.isNaN(lastAttemptAt.getTime()) &&
        Date.now() - lastAttemptAt.getTime() < MIN_GAP_MINUTES * 60 * 1000
      ) {
        const waitMs =
          MIN_GAP_MINUTES * 60 * 1000 - (Date.now() - lastAttemptAt.getTime());
        const waitMin = Math.ceil(waitMs / 60000);

        return res.status(429).json({
          success: false,
          message: `Retry throttled. Try again in about ${waitMin} minute(s).`,
        });
      }

      try {
        const sellerPath = `sellerFulfillment.${sellerId}.shipping`;
        await Orders.updateOne(
          { _id: orderId },
          {
            $set: {
              [`${sellerPath}.lastManualRetryAt`]: new Date(),
              [`${sellerPath}.lastManualRetryBy`]: getActorId(req),
              [`${sellerPath}.lastManualRetryReason`]: "admin_retry",
              updatedAt: new Date(),
            },
          }
        );
      } catch (e) {
        console.error("[shipping][admin-retry] audit write failed:", e?.message || e);
      }

      try {
        bookShipmentFireAndForget({
          orderId: String(orderId),
          sellerId,
          reason: "admin_retry",
        });
      } catch (e) {
        console.error("[shipping][admin-retry] enqueue failed:", e?.message || e);
        return res.status(500).json({
          success: false,
          message: "Failed to queue retry for shipping booking.",
        });
      }

      return res.json({
        success: true,
        message: "Retry queued for shipping booking.",
      });
    } catch (err) {
      console.error(
        "POST /api/admin/orders/:orderId/sellers/:sellerId/retry-shipping error:",
        err
      );
      return res
        .status(500)
        .json({ success: false, message: "Failed to retry shipping" });
    }
  }
);

router.get("/__probe", (req, res) => {
  return res.json({
    ok: true,
    route: "adminOrdersRoutes",
    mountedExpected: "/api/admin/orders",
    ts: new Date().toISOString(),
  });
});
// DETAIL: GET /api/admin/orders/:id
router.get("/:id", authMiddleware, isActiveMiddleware, ensureAdminForOrders, handleAdminOrderDetail);

export default router;
