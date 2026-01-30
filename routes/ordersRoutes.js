// routes/ordersRoutes.js
import express from "express";
import { ObjectId } from "mongodb";
import PDFDocument from "pdfkit";
import { RETURN_STATUS, canTransitionReturnStatus, normalizeReturnStatus } from "../utils/returnsStatus.js";

import { client, getDB } from "../dbConfig.js";
import { postTransactionGroup } from "../services/finance/postTransactionGroup.js";
import { authMiddleware } from "../middlewares/authMiddleware.js";
import { applyDiscounts } from "../utils/discountEngine.js";
import multer from "multer";
import { bookShipmentFactory, bookReturnShipment } from "../utils/shippingBridge.js";
import { enqueueNotification } from "../utils/outbox.js";

const router = express.Router();

const dbName = process.env.DB_NAME || "glamzi_ecommerce";
const db = client.db(dbName);

const Orders = db.collection("orders");
const Carts = db.collection("carts");
const Products = db.collection("products");
const Users = db.collection("users");
const SellerSettings = db.collection("seller_settings");
const SellerSettingsLegacy = db.collection("sellerSettings");
const Invoices = db.collection("invoices");
const Discounts = db.collection("discounts");
const FlashReservations = db.collection("flashReservations");
const CommissionSettings = db.collection("commissionSettings");

const bookShipmentFireAndForget = bookShipmentFactory({ Orders, Users });

// ✅ Required for perUserLimit tracking + idempotency
const CouponRedemptions = db.collection("couponRedemptions");
const CouponRedemptionEvents = db.collection("couponRedemptionEvents");

// Multer (in-memory) for small return attachments
const uploadReturn = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024, // 5 MB per file
    files: 5,
  },
});

// ===============================
// COD INVOICE HELPER
// ===============================
function buildCodInvoiceSnapshot(orderDoc) {
  if (!orderDoc) {
    throw new Error("buildCodInvoiceSnapshot: orderDoc is required");
  }

  const items = (orderDoc.items || []).map((it) => {
    const base = Number(it?.pricing?.base ?? it.price ?? 0);
    const sellerDisc = Number(it?.pricing?.sellerDiscount ?? 0);
    const sellerNet = Math.max(0, base - sellerDisc);

    return {
      productId: it.productId,
      title: it.title,
      price: sellerNet, // seller receivable per-unit (admin-funded discounts excluded)
      quantity: it.quantity,
      sellerId: it.sellerId,
      categoryId: it.categoryId,
      image: it.image,
      pricing: it.pricing || null,
      appliedDiscounts: it.appliedDiscounts || null,
    };
  });

  const itemsTotal = items.reduce(
    (sum, it) => sum + Number(it.price || 0) * Number(it.quantity || 0),
    0
  );

  const shippingFee =
    (orderDoc.totals && Number(orderDoc.totals.shippingFee)) || 0;
  const shippingDiscount =
    (orderDoc.totals && Number(orderDoc.totals.shippingDiscount)) || 0;

  let totalAmount = null;
  if (
    orderDoc.totals &&
    orderDoc.totals.grandTotal !== undefined &&
    orderDoc.totals.grandTotal !== null
  ) {
    totalAmount = Number(orderDoc.totals.grandTotal);
  } else {
    totalAmount = itemsTotal + shippingFee - shippingDiscount;
  }

  return {
    type: "cod_snapshot",
    orderId: orderDoc._id,
    orderIdStr: orderDoc._id?.toString?.() || String(orderDoc._id || ""),
    status: "issued",
    totalAmount,
    paymentMethod: orderDoc.paymentMethod || "cod",
    orderStatus: orderDoc.status,
    items,
    createdAt: new Date(),
  };
}

/* ===============================
   HELPERS
=============================== */
function toObjectId(id) {
  if (!id) return null;
  try {
    const s = String(id).trim();
    if (!ObjectId.isValid(s)) return null;
    return new ObjectId(s);
  } catch {
    return null;
  }
}

function safeString(v) {
  return typeof v === "string" ? v.trim() : "";
}

function escapeRegex(input = "") {
  return String(input).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeStatus(s) {
  return String(s || "").trim().toLowerCase();
}

function normalizePayStatus(s) {
  const v = String(s || "").trim().toLowerCase();
  return v === "paid" ? "paid" : "pending";
}

function moneyNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

const AUTO_REFUND_RETURN_AFTER_RECEIVED =
  String(process.env.AUTO_REFUND_RETURN_AFTER_RECEIVED ?? "true").trim().toLowerCase() !== "false";

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

/* ===============================
   SHIPPING BOOKING LOGS (Ops)
=============================== */
function buildSellerShippingPath(sellerIdStr) {
  return `sellerFulfillment.${sellerIdStr}.shipping`;
}

function truncateStr(s, max = 400) {
  const v = typeof s === "string" ? s : "";
  if (!v) return null;
  return v.length > max ? v.slice(0, max) : v;
}

async function markShippingBookingQueued({ Orders, orderId, sellerIdStr }) {
  const path = buildSellerShippingPath(sellerIdStr);
  const oid = toObjectId(orderId);
  if (!oid) return;
  const now = new Date();

  await Orders.updateOne(
    { _id: oid },
    [
      {
        $set: {
          [`${path}.bookingState`]: "queued",
          [`${path}.lastBookingAttemptAt`]: now,
          [`${path}.updatedAt`]: now,
          [`${path}.bookingRetryCount`]: {
            $ifNull: [`$${path}.bookingRetryCount`, 0],
          },
        },
      },
    ]
  );
}

async function appendShippingBookingAttempt({
  Orders,
  orderId,
  sellerIdStr,
  attempt,
  ok,
  httpStatus,
  code,
  message,
  durationMs,
  shipmentId,
  trackingNumber,
}) {
  const path = buildSellerShippingPath(sellerIdStr);
  const now = new Date();

  const attemptDoc = {
    at: now,
    attempt: Number(attempt || 1),
    ok: Boolean(ok),
    status: Number.isFinite(Number(httpStatus)) ? Number(httpStatus) : null,
    code: truncateStr(code, 60),
    message: truncateStr(message, 400),
    durationMs: Number.isFinite(Number(durationMs)) ? Number(durationMs) : null,
    shipmentId: truncateStr(shipmentId, 80),
    trackingNumber: truncateStr(trackingNumber, 80),
  };

  const update = {
    $push: { [`${path}.bookingAttempts`]: attemptDoc },
    $set: {
      [`${path}.lastBookingAttemptAt`]: now,
      [`${path}.updatedAt`]: now,
      [`${path}.bookingState`]: ok ? "booked" : "failed",
    },
    $inc: { [`${path}.bookingRetryCount`]: 1 },
  };

  if (!ok) {
    update.$set[`${path}.lastBookingError`] = {
      at: now,
      status: attemptDoc.status,
      code: attemptDoc.code,
      message: attemptDoc.message,
    };
  } else {
    update.$set[`${path}.lastBookingError`] = null;
    if (trackingNumber) update.$set[`${path}.trackingNumber`] = trackingNumber;
    if (shipmentId) update.$set[`${path}.shipmentId`] = shipmentId;
    update.$set[`${path}.bookedAt`] = now;
  }

  await Orders.updateOne({ _id: new ObjectId(orderId) }, update);
}

/**
 * Build a canonical commission + totals snapshot for an invoice.
 */
function buildInvoiceCommissionSnapshot({
  sellerTotals = {},
  commissionInfo = {},
  currency = "NPR",
}) {
  const gross = moneyNum(
    sellerTotals.subtotalBase ??
      sellerTotals.subtotal ??
      sellerTotals.total ??
      sellerTotals.gross ??
      0
  );

  const commissionAmount = moneyNum(
    commissionInfo.amount ?? commissionInfo.commission ?? 0
  );

  const net = moneyNum(sellerTotals.grandTotal ?? gross - commissionAmount);

  const rateType = (commissionInfo.rateType || "percentage").toLowerCase();
  const rate = Number.isFinite(Number(commissionInfo.rate))
    ? Number(commissionInfo.rate)
    : null;

  const snapshot = {
    currency,
    gross,
    commission: commissionAmount,
    net,
  };

  const commissionSnapshot = {
    amount: commissionAmount,
    rateType,
    rate,
    source: commissionInfo.source || "default",
    ruleId: commissionInfo.ruleId || null,
    calculatedFrom: {
      gross,
      sellerGrandTotal: sellerTotals.grandTotal ?? null,
    },
    snapshotAt: new Date(),
  };

  return {
    totals: {
      ...(sellerTotals.totals || {}),
      currency,
      gross,
      commission: commissionAmount,
      net,
    },
    sellerTotals: {
      ...sellerTotals,
      subtotalBase: gross,
      grandTotal: net,
      net,
    },
    grossTotal: gross,
    commissionTotal: commissionAmount,
    netPayout: net,
    commission: commissionSnapshot,
  };
}

async function getDefaultCommissionRate() {
  const doc = await CommissionSettings.findOne(
    { _id: "default" },
    { projection: { "settings.global.rateType": 1, "settings.global.rate": 1 } }
  );

  const rateType =
    doc?.settings?.global?.rateType?.toLowerCase() === "flat"
      ? "flat"
      : "percentage";
  const rate = Number(doc?.settings?.global?.rate ?? 0);
  return { rateType, rate };
}

function getAuthUserId(req) {
  return String(
    req.user?.id ||
      req.user?._id ||
      req.user?.userId ||
      req.user?.uid ||
      req.user?.email ||
      ""
  );
}

function ensureSeller(req, res) {
  if (normalizeStatus(req.user?.role) !== "seller") {
    res.status(403).json({ success: false, message: "Seller access only" });
    return false;
  }
  return true;
}

function ensureCustomer(req, res) {
  const r = normalizeStatus(req.user?.role);
  if (r !== "customer" && r !== "user") {
    res.status(403).json({ success: false, message: "Customer access only" });
    return false;
  }
  return true;
}

function ensureAdminOrStaff(req, res) {
  if (!isAdminOrStaffRole(req)) {
    res.status(403).json({ success: false, message: "Admin access only" });
    return false;
  }
  return true;
}

function isAdminFinance(req) {
  const role = normalizeStatus(req.user?.role);
  return role === "super-admin" || role === "admin" || role === "account";
}

function isAdminOrStaffRole(req) {
  const role = normalizeStatus(req.user?.role);
  return (
    role === "super-admin" ||
    role === "admin" ||
    role === "account" ||
    role === "staff"
  );
}

function getActorId(req) {
  return String(req.user?._id || req.user?.id || req.user?.email || "");
}

function getSellerIdFromReq(req) {
  // Canonical in Glamzi: sellerId stored on items is product.userId (string).
  return String(req.user?._id || req.user?.id || "");
}

function logReturnEvent(event, meta = {}) {
  console.info(
    `[returns][${event}]`,
    {
      orderId: meta.orderId || meta.orderNumber || null,
      sellerId: meta.sellerId || null,
      decision: (meta.decision || "").toLowerCase() || undefined,
      status: meta.status || null,
      message: meta.message || null,
    }
  );
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

async function resolveSellerObjectId(req) {
  const sellerIdStr = getSellerIdFromReq(req);
  const oid = toObjectId(sellerIdStr);
  if (oid) return oid;

  const email = safeString(req.user?.email);
  if (email) {
    const u = await Users.findOne({ email });
    if (u?._id) return u._id;
  }
  return null;
}

async function getCartByUserId(userId) {
  const oid = toObjectId(userId);
  if (oid) {
    const byOid = await Carts.findOne({ userId: oid });
    if (byOid) return byOid;
  }
  return Carts.findOne({ userId: String(userId) });
}

function normalizeCouponCode(code) {
  const c = safeString(code).toUpperCase().replace(/\s+/g, "");
  if (!/^[A-Z0-9_-]{3,30}$/.test(c)) return "";
  return c;
}

function asDateOrNull(v) {
  if (!v) return null;
  const dt = new Date(v);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

function getStart(d) {
  return d?.startAt ?? d?.startsAt ?? null;
}
function getEnd(d) {
  return d?.endAt ?? d?.endsAt ?? null;
}

function inWindow(d, now = new Date()) {
  const s = asDateOrNull(getStart(d));
  const e = asDateOrNull(getEnd(d));
  const sOk = !s || s <= now;
  const eOk = !e || e >= now;
  return sOk && eOk;
}

function normalizeAuthority(d) {
  return String(d?.authority || "").trim().toLowerCase();
}

function normalizeCodeType(d) {
  const ct = String(d?.codeType || "").trim().toLowerCase();
  if (ct === "coupon" || ct === "campaign") return ct;
  return d?.code ? "coupon" : "campaign";
}

function isActiveDiscountDoc(d) {
  const byBool = d?.isActive === true;
  const byStatus = String(d?.status || "").toLowerCase() === "active";
  return byBool || byStatus;
}

function isDisabledDiscountDoc(d) {
  if (d?.disabledAt) return true;
  const st = String(d?.status || "").toLowerCase();
  if (st === "disabled" || st === "inactive") return true;
  return false;
}

/**
 * Fulfillment lifecycle transitions (per-seller segment)
 * Seller UI restricted to <= shipped. Admin can do delivered/completed/returns.
 */
const STATUS_TRANSITIONS = {
  created: ["confirmed", "cancelled"],
  confirmed: ["processing", "cancelled"],
  processing: ["ready_to_ship"],
  ready_to_ship: ["shipped"],
  shipped: ["delivered"],
  delivered: ["completed", "return_requested"],
  return_requested: ["returned", "completed"],
  returned: ["refunded"],
  completed: [],
  cancelled: [],
  refunded: [],
};

function canTransition(from, to) {
  const allowed = STATUS_TRANSITIONS[normalizeStatus(from)] || [];
  return allowed.includes(normalizeStatus(to));
}

function getAllowedNextStatuses(currentStatus) {
  return STATUS_TRANSITIONS[normalizeStatus(currentStatus)] || [];
}

function timestampFieldForStatus(status) {
  const map = {
    created: "createdAt",
    confirmed: "confirmedAt",
    processing: "processingAt",
    ready_to_ship: "readyToShipAt",
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

function sellerCanSetStatus(target) {
  const t = normalizeStatus(target);
  return ["confirmed", "processing", "ready_to_ship", "shipped", "cancelled"].includes(t);
}

function isActiveReturnFlow(order) {
  const status = normalizeStatus(order?.returnRequest?.status || "");
  return Boolean(status) && status !== "cancelled";
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
  if (any("ready_to_ship")) return "ready_to_ship";
  if (any("processing")) return "processing";
  if (any("confirmed")) return "confirmed";
  if (all("cancelled")) return "cancelled";

  return "created";
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

function projectSellerView(order, sellerIdStr) {
  const sellerItems = (order.items || []).filter(
    (it) => String(it?.sellerId || "") === sellerIdStr
  );

  const itemsCount = sellerItems.reduce(
    (sum, it) => sum + (Number(it.quantity) || 1),
    0
  );

  const totalAmount = sellerItems.reduce((sum, it) => {
    const base = Number(it?.pricing?.base ?? it.price ?? 0);
    const sellerDisc = Number(it?.pricing?.sellerDiscount ?? 0);
    const sellerNet = Math.max(0, base - sellerDisc);
    return sum + sellerNet * (Number(it.quantity) || 1);
  }, 0);

  const customerName =
    order.customerName ||
    order.shippingAddress?.fullName ||
    order.shippingAddress?.name ||
    "";
  const customerPhone = order.customerPhone || order.shippingAddress?.phone || "";
  const customerEmail = order.customerEmail || "";

  const sellerSegment = order?.sellerFulfillment?.[sellerIdStr] || {
    status: "created",
  };
  const paySeg =
    (order?.sellerPayments && order.sellerPayments[sellerIdStr]) || null;

  const sellerStatus = normalizeStatus(sellerSegment.status || "created");
  const sellerPaymentStatus = normalizeStatus(
    paySeg?.status ||
      sellerSegment.paymentStatus ||
      order.paymentStatus ||
      "pending"
  );

  return {
    _id: order._id,
    orderNumber: order.orderNumber || null,
    invoiceNumber: order.invoiceNumber || null,

    createdAt: order.createdAt,
    updatedAt: order.updatedAt,

    paymentMethod: order.paymentMethod,
    paymentStatus: normalizeStatus(order.paymentStatus || "pending"),
    totals: order.totals || null,

    overallStatus: normalizeStatus(order.status || "created"),
    sellerStatus,
    allowedNextStatuses: getAllowedNextStatuses(sellerStatus),

    sellerPaymentStatus,
    sellerPaidAt: paySeg?.paidAt || sellerSegment?.paidAt || null,
    sellerPaidBy: paySeg?.paidBy || sellerSegment?.paidBy || null,

    customer: {
      name: customerName,
      phone: customerPhone,
      email: customerEmail,
    },

    sellerMeta: { ...sellerSegment },

    itemsCount,
    totalAmount,
    items: sellerItems,
  };
}

/**
 * Invoice config loader (seller branding/settings)
 */
async function loadSellerInvoiceConfig(sellerIdObj) {
  const sellerIdStr = sellerIdObj.toString();

  const [sellerUser, settingsDoc, adminDefaultsDoc] = await Promise.all([
    Users.findOne({ _id: sellerIdObj }),
    (async () =>
      (await SellerSettings.findOne({
        $or: [{ sellerId: sellerIdObj }, { sellerId: sellerIdStr }],
      })) ||
      (await SellerSettingsLegacy.findOne({
        $or: [{ sellerId: sellerIdObj }, { sellerId: sellerIdStr }],
      })))(),
    (async () =>
      (await SellerSettings.findOne({
        $or: [{ sellerId: "admin_invoice_defaults" }, { sellerId: "admin" }],
      })) ||
      (await SellerSettingsLegacy.findOne({
        $or: [{ sellerId: "admin_invoice_defaults" }, { sellerId: "admin" }],
      })))(),
  ]);

  const adminDefaults =
    adminDefaultsDoc?.invoiceConfig ||
    adminDefaultsDoc?.invoice ||
    adminDefaultsDoc?.settings ||
    adminDefaultsDoc ||
    {};

  const sellerConfig =
    settingsDoc?.invoiceConfig ||
    settingsDoc?.invoice ||
    settingsDoc?.settings ||
    settingsDoc ||
    {};

  const merged = { ...adminDefaults, ...sellerConfig };

  const invoiceConfig = {
    ...merged,
    invoiceEnabled: merged.invoiceEnabled !== false,
    invoicePrefix: merged.invoicePrefix || "INV-",
    nextInvoiceNumber: Number.isFinite(Number(merged.nextInvoiceNumber))
      ? Number(merged.nextInvoiceNumber)
      : Number.isFinite(Number(adminDefaults.nextInvoiceNumber))
      ? Number(adminDefaults.nextInvoiceNumber)
      : 1001,
    showLogoOnInvoice: merged.showLogoOnInvoice ?? false,
    showGlamziLogo: merged.showGlamziLogo ?? false,
    invoiceLogo: merged.invoiceLogo || merged.logoUrl || null,
    showStoreAddress: merged.showStoreAddress !== false,
    showCustomerPhone: merged.showCustomerPhone !== false,
    showTaxInfo: merged.showTaxInfo !== false,
    taxLabel: merged.taxLabel || "VAT",
    taxRate: merged.taxRate ?? "",
    paymentDueDays: Number.isFinite(Number(merged.paymentDueDays))
      ? Number(merged.paymentDueDays)
      : 0,
    footerNote:
      merged.footerNote ||
      merged.footerText ||
      merged.legalText ||
      merged.terms ||
      "",
    usingAdminDefaults: !settingsDoc,
  };

  const storeName =
    invoiceConfig?.storeName ||
    sellerUser?.storeName ||
    sellerUser?.shopName ||
    sellerUser?.storeDisplayName ||
    sellerUser?.shopDisplayName ||
    sellerUser?.name ||
    null;

  const storeEmail = invoiceConfig?.email || sellerUser?.email || null;
  const storePhone = invoiceConfig?.phone || sellerUser?.phone || null;

  const storeAddress =
    invoiceConfig?.address ||
    invoiceConfig?.storeAddress ||
    sellerUser?.address ||
    null;

  const taxId =
    invoiceConfig?.panVatNumber ||
    invoiceConfig?.panVat ||
    invoiceConfig?.panNumber ||
    invoiceConfig?.taxId ||
    null;

  const logoUrl =
    invoiceConfig?.invoiceLogo ||
    invoiceConfig?.logoUrl ||
    merged?.logoUrl ||
    null;
  const invoicePrefix = invoiceConfig?.invoicePrefix || "INV-";

  return {
    invoiceConfig,
    header: {
      storeName,
      storeEmail,
      storePhone,
      storeAddress,
      taxId,
      logoUrl,
      invoicePrefix,
      showStoreAddress: invoiceConfig.showStoreAddress,
      showCustomerPhone: invoiceConfig.showCustomerPhone,
      showTaxInfo: invoiceConfig.showTaxInfo,
      taxLabel: invoiceConfig.taxLabel,
      taxRate: invoiceConfig.taxRate,
      paymentDueDays: invoiceConfig.paymentDueDays,
      footerNote: invoiceConfig.footerNote,
      showLogoOnInvoice: invoiceConfig.showLogoOnInvoice,
      showGlamziLogo: invoiceConfig.showGlamziLogo,
      invoiceLogo: invoiceConfig.invoiceLogo || logoUrl,
    },
  };
}

/**
 * Atomic invoice number allocation per seller
 */
async function allocateSellerInvoiceNumber(sellerIdObj) {
  const sellerIdStr = sellerIdObj.toString();
  const now = new Date();

  const adminDefaultsDoc =
    (await SellerSettings.findOne({
      $or: [{ sellerId: "admin_invoice_defaults" }, { sellerId: "admin" }],
    })) ||
    (await SellerSettingsLegacy.findOne({
      $or: [{ sellerId: "admin_invoice_defaults" }, { sellerId: "admin" }],
    }));
  const adminCfg =
    adminDefaultsDoc?.invoiceConfig ||
    adminDefaultsDoc?.invoice ||
    adminDefaultsDoc?.settings ||
    adminDefaultsDoc ||
    {};
  const filter = { $or: [{ sellerId: sellerIdObj }, { sellerId: sellerIdStr }] };

  const existingDoc =
    (await SellerSettings.findOne(filter)) ||
    (await SellerSettingsLegacy.findOne(filter)) ||
    {};
  const existingCfg =
    existingDoc.invoiceConfig ||
    existingDoc.invoice ||
    existingDoc.settings ||
    existingDoc ||
    {};

  const defaultPrefix =
    existingCfg.invoicePrefix || adminCfg.invoicePrefix || "INV-";
  const defaultNext = Number.isFinite(Number(existingCfg.nextInvoiceNumber))
    ? Number(existingCfg.nextInvoiceNumber)
    : Number.isFinite(Number(adminCfg.nextInvoiceNumber))
    ? Number(adminCfg.nextInvoiceNumber)
    : 1001;

  // Ensure a settings doc exists with initial sequence values before incrementing.
  await SellerSettings.updateOne(
    filter,
    {
      $setOnInsert: {
        sellerId: sellerIdObj,
        createdAt: now,
        "invoiceConfig.nextInvoiceNumber": defaultNext,
        "invoice.nextInvoiceNumber": defaultNext,
        "invoiceConfig.invoicePrefix": defaultPrefix,
        "invoice.invoicePrefix": defaultPrefix,
      },
      $set: {
        updatedAt: now,
      },
    },
    { upsert: true }
  );

  const invoiceUpdate = {
    $set: {
      updatedAt: now,
    },
    $inc: {
      "invoiceConfig.nextInvoiceNumber": 1,
      "invoice.nextInvoiceNumber": 1,
    },
  };

  let settingsResult = null;
  const maxSequenceAttempts = 2;
  for (let attempt = 1; attempt <= maxSequenceAttempts; attempt += 1) {
    try {
      settingsResult = await SellerSettings.findOneAndUpdate(
        filter,
        invoiceUpdate,
        { returnDocument: "before" }
      );
      break;
    } catch (err) {
      if (
        attempt < maxSequenceAttempts &&
        err?.code === 40 &&
        String(err?.errmsg || "").includes("invoiceConfig.nextInvoiceNumber")
      ) {
        console.warn("[orders][invoice] retrying invoice sequence allocation after conflict", {
          sellerId: sellerIdStr,
          attempt,
          message: err?.errmsg,
        });
        continue;
      }
      throw err;
    }
  }

  if (!settingsResult) {
    throw new Error("Failed to allocate invoice number");
  }

  const docBefore = settingsResult?.value || {};
  const cfgBefore =
    docBefore.invoiceConfig ||
    docBefore.invoice ||
    docBefore.settings ||
    existingCfg ||
    {};
  const prefix = cfgBefore.invoicePrefix || defaultPrefix;
  let nextNum = Number(cfgBefore.nextInvoiceNumber);

  if (!Number.isFinite(nextNum) || nextNum <= 0) {
    nextNum = defaultNext;
  }

  const docAfter = await SellerSettings.findOne(filter);
  if (docAfter) {
    const cfgAfter =
      docAfter.invoiceConfig ||
      docAfter.invoice ||
      docAfter.settings ||
      existingCfg ||
      {};
    const hasPrefix =
      safeString(cfgAfter.invoicePrefix) ||
      safeString((docAfter.invoice || {}).invoicePrefix) ||
      "";
    if (!hasPrefix) {
      await SellerSettings.updateOne(
        { _id: docAfter._id },
        {
          $set: {
            "invoiceConfig.invoicePrefix": prefix,
            "invoice.invoicePrefix": prefix,
          },
        }
      );
    }
  }

  return { prefix, number: nextNum };
}

function buildDateRange(period, from, to) {
  const now = new Date();
  let start = null;
  let end = null;

  switch ((period || "last30").toLowerCase()) {
    case "today":
      start = new Date(now);
      start.setHours(0, 0, 0, 0);
      end = new Date(now);
      end.setHours(23, 59, 59, 999);
      break;
    case "last7":
      end = new Date(now);
      end.setHours(23, 59, 59, 999);
      start = new Date(end);
      start.setDate(end.getDate() - 6);
      start.setHours(0, 0, 0, 0);
      break;
    case "last30":
      end = new Date(now);
      end.setHours(23, 59, 59, 999);
      start = new Date(end);
      start.setDate(end.getDate() - 29);
      start.setHours(0, 0, 0, 0);
      break;
    case "custom":
      if (from) {
        const s = new Date(from);
        if (!Number.isNaN(s.getTime())) {
          s.setHours(0, 0, 0, 0);
          start = s;
        }
      }
      if (to) {
        const e = new Date(to);
        if (!Number.isNaN(e.getTime())) {
          e.setHours(23, 59, 59, 999);
          end = e;
        }
      }
      break;
    case "all":
    default:
      start = null;
      end = null;
      break;
  }
  return { start, end };
}

function safePdfFilename(name) {
  const base = safeString(name) || "invoice";
  return base.replace(/[^a-zA-Z0-9-_(). ]/g, "").slice(0, 80) || "invoice";
}

/* ===============================
   COUPON RESERVATION (AT ORDER CREATE)
=============================== */
async function reserveAdminCouponOrNull({
  couponCode,
  userIdStr,
  orderNumber,
  cartSubtotal,
  db,
  session,
}) {
  const code = String(couponCode || "").trim().toUpperCase().replace(/\s+/g, "");
  if (!code) return null;

  const now = new Date();
  const subtotal = Number(cartSubtotal);
  if (!Number.isFinite(subtotal) || subtotal < 0) {
    throw new Error("Invalid cart subtotal for coupon reservation");
  }

  const coupon = await Discounts.findOne(
    {
      authority: "admin",
      codeType: "coupon",
      code,
      $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
    },
    { session }
  );

  if (!coupon) {
    const err = new Error("Invalid coupon code");
    err.statusCode = 400;
    throw err;
  }

  const st = String(coupon.status || "").toLowerCase();
  if (
    coupon.disabledAt ||
    st === "disabled" ||
    st === "inactive" ||
    st === "paused"
  ) {
    const err = new Error("Coupon is not active");
    err.statusCode = 400;
    throw err;
  }

  const startAt = coupon.startAt ? new Date(coupon.startAt) : null;
  const endAt = coupon.endAt ? new Date(coupon.endAt) : null;
  if (startAt && startAt > now) {
    const err = new Error("Coupon is not started yet");
    err.statusCode = 400;
    throw err;
  }
  if (endAt && endAt < now) {
    const err = new Error("Coupon has expired");
    err.statusCode = 400;
    throw err;
  }

  // Idempotency per orderNumber
  try {
    await CouponRedemptionEvents.insertOne(
      {
        discountId: String(coupon._id),
        userId: String(userIdStr),
        orderNumber: String(orderNumber),
        code,
        createdAt: now,
      },
      { session }
    );
  } catch (e) {
    if (String(e?.code) === "11000") {
      return {
        discountId: String(coupon._id),
        code,
        kind: coupon.kind,
        value: coupon.value,
      };
    }
    throw e;
  }

  const usageLimitTotal =
    coupon.usageLimitTotal == null ? null : Number(coupon.usageLimitTotal);

  const discountReserveFilter = {
    _id: coupon._id,
    authority: "admin",
    codeType: "coupon",
    code,
    $and: [
      { $or: [{ disabledAt: null }, { disabledAt: { $exists: false } }] },
      { status: { $in: ["active", "ACTIVE"] } },
      {
        $or: [
          { startAt: null },
          { startAt: { $exists: false } },
          { startAt: { $lte: now } },
        ],
      },
      {
        $or: [
          { endAt: null },
          { endAt: { $exists: false } },
          { endAt: { $gte: now } },
        ],
      },
      {
        $expr: {
          $lte: [{ $ifNull: ["$minCartSubtotal", 0] }, subtotal],
        },
      },
      ...(usageLimitTotal == null
        ? []
        : [
            {
              $expr: {
                $lt: [{ $ifNull: ["$usedCount", 0] }, usageLimitTotal],
              },
            },
          ]),
    ],
  };

  const r1 = await Discounts.updateOne(
    discountReserveFilter,
    {
      $inc: { usedCount: 1 },
      $set: { updatedAt: now },
    },
    { session }
  );

  if (r1.modifiedCount !== 1) {
    await CouponRedemptionEvents.deleteOne(
      {
        discountId: String(coupon._id),
        userId: String(userIdStr),
        orderNumber: String(orderNumber),
      },
      { session }
    );

    const err = new Error(
      "Coupon is not eligible (min cart / expired / limit reached)"
    );
    err.statusCode = 400;
    throw err;
  }

  const perUserLimit =
    coupon.perUserLimit == null ? null : Number(coupon.perUserLimit);

  const perUserFilter = {
    discountId: String(coupon._id),
    userId: String(userIdStr),
    ...(perUserLimit == null
      ? {}
      : {
          $or: [
            { usedCount: { $exists: false } },
            { usedCount: { $lt: perUserLimit } },
          ],
        }),
  };

  const r2 = await CouponRedemptions.updateOne(
    perUserFilter,
    {
      $setOnInsert: {
        discountId: String(coupon._id),
        userId: String(userIdStr),
        createdAt: now,
      },
      $inc: { usedCount: 1 },
      $set: {
        updatedAt: now,
        lastOrderNumber: String(orderNumber),
        lastCode: code,
      },
    },
    { session, upsert: true }
  );

  if (perUserLimit != null && r2.matchedCount === 0 && r2.upsertedCount === 0) {
    await Discounts.updateOne(
      { _id: coupon._id },
      { $inc: { usedCount: -1 }, $set: { updatedAt: now } },
      { session }
    );

    await CouponRedemptionEvents.deleteOne(
      {
        discountId: String(coupon._id),
        userId: String(userIdStr),
        orderNumber: String(orderNumber),
      },
      { session }
    );

    const err = new Error("Coupon per-user limit reached");
    err.statusCode = 400;
    throw err;
  }

  return {
    discountId: String(coupon._id),
    code,
    kind: coupon.kind,
    value: coupon.value,
  };
}

/* ===============================
   INVOICE ISSUANCE (REUSABLE)
=============================== */
async function issueInvoiceForSellerOrder({ sellerIdStr, sellerIdObj, order }) {
  if (!sellerIdStr || !sellerIdObj || !order?._id) {
    return { ok: false, status: 400, message: "Invalid id(s)" };
  }

  const existing = await Invoices.findOne({
    sellerId: sellerIdStr,
    orderId: order._id.toString(),
  });
  if (existing) return { ok: true, created: false, invoice: existing };

  const sellerView = projectSellerView(order, sellerIdStr);
  if (!sellerView.items || sellerView.items.length === 0) {
    return {
      ok: false,
      status: 400,
      message:
        "No seller items found for this order. Check order.items[].sellerId mapping.",
    };
  }

  const { invoiceConfig, header } = await loadSellerInvoiceConfig(sellerIdObj);
  const { prefix, number } = await allocateSellerInvoiceNumber(sellerIdObj);
  const invoiceNumber = `${prefix}${number}`;
  const usingAdminDefaults = !!invoiceConfig?.usingAdminDefaults;

  const now = new Date();

  const enrichItems = (items = []) =>
    items.map((it) => {
      const qty = Math.max(1, Number(it.quantity || 1));

      const lineBase =
        it?.pricing?.base != null
          ? Number(it.pricing.base)
          : Number(it?.price ?? 0) * qty;

      const lineSellerDiscount =
        it?.pricing?.sellerDiscount != null
          ? Number(it.pricing.sellerDiscount)
          : 0;

      const lineAdminDiscount =
        it?.pricing?.adminDiscount != null
          ? Number(it.pricing.adminDiscount)
          : 0;

      const lineFinal =
        it?.pricing?.final != null
          ? Number(it.pricing.final)
          : Math.max(0, lineBase - lineSellerDiscount - lineAdminDiscount);

      const baseUnitPrice = qty > 0 ? lineBase / qty : 0;
      const sellerDiscountUnit = qty > 0 ? lineSellerDiscount / qty : 0;
      const adminDiscountUnit = qty > 0 ? lineAdminDiscount / qty : 0;
      const finalUnitPrice = qty > 0 ? lineFinal / qty : 0;

      const pricing = {
        base: lineBase,
        sellerDiscount: lineSellerDiscount,
        adminDiscount: lineAdminDiscount,
        final: lineFinal,
      };

      return {
        ...it,
        pricing: { ...(it.pricing || {}), ...pricing },
        baseUnitPrice,
        sellerDiscountUnit,
        adminDiscountUnit,
        finalUnitPrice,
      };
    });

  const enrichedItems = enrichItems(sellerView.items || []);

  const calcSellerTotals = (items = []) => {
    let subtotalBase = 0;
    let subtotalSellerNet = 0;
    let sellerDiscountTotal = 0;
    let adminDiscountTotal = 0;

    for (const it of items) {
      const lineBase = Number(it?.pricing?.base ?? 0);
      const lineSellerDiscount = Number(it?.pricing?.sellerDiscount ?? 0);
      const lineAdminDiscount = Number(it?.pricing?.adminDiscount ?? 0);

      const lineSellerNet = Math.max(0, lineBase - lineSellerDiscount);

      subtotalBase += lineBase;
      subtotalSellerNet += lineSellerNet;
      sellerDiscountTotal += lineSellerDiscount;
      adminDiscountTotal += lineAdminDiscount;
    }

    return {
      subtotalBase,
      discountedSubtotal: subtotalSellerNet, // seller net (before commission)
      discountTotal: sellerDiscountTotal,
      sellerDiscountTotal,
      adminDiscountTotal,
      grandTotal: subtotalSellerNet,
    };
  };

  const sellerTotals = calcSellerTotals(enrichedItems);
  const gross = moneyNum(sellerTotals?.subtotalBase || 0);
  const currency = order.currency || "NPR";

  // Commission info (prefer codInvoice snapshot if present)
  const codCommission =
    order?.codInvoice?.commissionSnapshot || order?.codInvoice?.commission || null;

  let commissionInfo = {
    amount: 0,
    rateType: "percentage",
    rate: null,
    source: "invoice_issue_auto",
    ruleId: null,
  };

  if (codCommission) {
    const rateType = codCommission.rateType || codCommission.type || "percentage";
    const rate = codCommission.rate ?? codCommission.ratePercent ?? null;

    let amount = 0;
    if (codCommission.commissionAmount != null) {
      amount = moneyNum(codCommission.commissionAmount);
    } else if (rateType === "percentage" && rate != null) {
      amount = moneyNum((gross * Number(rate || 0)) / 100);
    } else if (rateType === "flat" && codCommission.amount != null) {
      amount = moneyNum(codCommission.amount);
    }

    commissionInfo = {
      amount,
      rateType,
      rate,
      source: codCommission.source || "invoice_issue_auto",
      ruleId: codCommission.ruleId || null,
    };
  } else if (order?.totals?.commission != null) {
    commissionInfo.amount = moneyNum(order.totals.commission);
  }

  // Fallback to default commission settings
  if (
    moneyNum(commissionInfo.amount) <= 0 &&
    (!commissionInfo.rate || Number(commissionInfo.rate) <= 0)
  ) {
    const { rateType, rate } = await getDefaultCommissionRate();
    if (rate) {
      commissionInfo.rateType = rateType;
      commissionInfo.rate = rate;
      commissionInfo.amount =
        rateType === "percentage"
          ? moneyNum((gross * rate) / 100)
          : moneyNum(rate);
    }
  }

  // Seller net after commission
  const sellerNet = moneyNum(gross - moneyNum(commissionInfo.amount || 0));
  const adjustedSellerTotals = {
    ...sellerTotals,
    grandTotal: sellerNet,
    net: sellerNet,
  };

  const snapshot = buildInvoiceCommissionSnapshot({
    sellerTotals: adjustedSellerTotals,
    commissionInfo,
    currency,
  });

  const payStatusNormalized = normalizeStatus(
    order.paymentStatus || order.payment?.status || ""
  );
  const payMethodNormalized = normalizeStatus(
    order.paymentMethod || order.payment?.method || ""
  );
  const isPrepaid = payMethodNormalized === "esewa" || payStatusNormalized === "paid";
  const paidAt = order.paidAt || order.payment?.paidAt || now;

  const invoiceDoc = {
    sellerId: sellerIdStr,
    orderId: order._id.toString(),
    orderNumber: order.orderNumber || null,

    invoiceNumber,
    invoiceDate: now,

    status: isPrepaid ? "paid" : "issued",
    paymentStatus: isPrepaid ? "paid" : "pending",
    paidAt: isPrepaid ? paidAt : null,
    currency,

    orderTotals: order?.totals || null,
    customerTotals: order?.totals || null,
    totals: snapshot.totals,
    sellerTotals: snapshot.sellerTotals,
    grossTotal: snapshot.grossTotal,
    commissionTotal: snapshot.commissionTotal,
    netPayout: snapshot.netPayout,
    sellerPayoutTotals: {
      currency,
      gross: snapshot.grossTotal,
      commission: snapshot.commissionTotal,
      net: snapshot.netPayout,
    },
    commissionSnapshot: snapshot.commission,
    commission: snapshot.commission,

    // Keep totalAmount as seller net payout (used by finance/payout modules)
    totalAmount: snapshot.netPayout,

    customer: {
      name: sellerView.customer?.name || "",
      email: sellerView.customer?.email || "",
      phone: sellerView.customer?.phone || "",
    },

    paymentMethod: order.paymentMethod || "cod",
    orderStatus: normalizeStatus(order.status || "created"),
    shippingAddress: order.shippingAddress || null,

    items: enrichedItems,

    header: header || null,
    invoiceConfig: invoiceConfig || null,
    usingAdminDefaults,

    invoiceUrl: null,
    createdAt: now,
    updatedAt: now,
  };

  try {
    const { insertedId } = await Invoices.insertOne(invoiceDoc);
    const created = await Invoices.findOne({ _id: insertedId });
    return { ok: true, created: true, invoice: created };
  } catch (err) {
    if (String(err?.code) === "11000") {
      const again = await Invoices.findOne({
        sellerId: sellerIdStr,
        orderId: order._id.toString(),
      });
      if (again) return { ok: true, created: false, invoice: again };
    }
    throw err;
  }
}

/* ===================================================
   CUSTOMER: ORDER QUOTE (READ-ONLY)
=================================================== */
router.post("/quote", authMiddleware, async (req, res) => {
  try {
    if (!ensureCustomer(req, res)) return;

    const userIdStr = getAuthUserId(req);
    const userObjId = toObjectId(userIdStr);
    if (!userObjId) {
      return res
        .status(401)
        .json({ success: false, message: "Invalid user session" });
    }

    const requestItems = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!requestItems.length) {
      return res
        .status(400)
        .json({ success: false, message: "Order items are required" });
    }

    const explicitCoupon = normalizeCouponCode(req.body?.couponCode);
    const cart = await getCartByUserId(userIdStr);
    const cartCoupon = normalizeCouponCode(cart?.adminCoupon?.code);
    const effectiveCouponCode = explicitCoupon || cartCoupon || "";

    const ids = requestItems
      .map((x) => toObjectId(x?.productId || x?.product?._id))
      .filter(Boolean);

    if (!ids.length) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid productId in items" });
    }

    const prods = await Products.find({ _id: { $in: ids } }).toArray();
    const pMap = new Map(prods.map((p) => [String(p._id), p]));

    const normalizedItems = [];
    let subtotal = 0;
    let totalQuantity = 0;

    for (const line of requestItems) {
      const pid = line?.productId || line?.product?._id;
      const productId = toObjectId(pid);
      if (!productId) {
        return res
          .status(400)
          .json({ success: false, message: "Invalid productId in items" });
      }

      const product = pMap.get(String(productId));
      if (!product) {
        return res
          .status(404)
          .json({ success: false, message: "Product not found in items" });
      }

      const quantity = Math.max(1, Math.floor(Number(line.quantity) || 1));
      const price = Number(product.price) || 0;

      const sellerId =
        (product.userId && String(product.userId)) ||
        (product.sellerId && String(product.sellerId)) ||
        (product.seller?._id && String(product.seller._id)) ||
        (product.store?._id && String(product.store._id)) ||
        null;
      if (!sellerId) {
        return res.status(400).json({
          success: false,
          message: "Product missing seller mapping (userId).",
        });
      }

      const categoryId =
        product?.categoryId?.toString?.() ||
        product?.categoryId ||
        product?.category?._id?.toString?.() ||
        product?.category?._id ||
        product?.category ||
        null;

      subtotal += price * quantity;
      totalQuantity += quantity;

      normalizedItems.push({
        productId: product._id,
        title: product.title || product.name || "Untitled",
        price,
        quantity,
        sellerId,
        categoryId: categoryId ? String(categoryId) : null,
        image: product.image || product.images?.[0] || null,
      });
    }

    let baseShippingFee = subtotal > 3000 ? 0 : 150;
    baseShippingFee = Math.max(0, Number(baseShippingFee || 0));

    const discountCartInput = {
      items: normalizedItems.map((it) => ({
        productId: String(it.productId),
        sellerId: String(it.sellerId),
        categoryId: it.categoryId ? String(it.categoryId) : null,
        price: Number(it.price || 0),
        quantity: Number(it.quantity || 1),
      })),
      shippingFee: baseShippingFee,
    };

    const pricing = await applyDiscounts(discountCartInput, {
      db,
      couponCode: effectiveCouponCode,
    });

    const pricingItems = Array.isArray(pricing?.items) ? pricing.items : [];
    const pricingMap = new Map(pricingItems.map((x) => [String(x.productId), x]));

    const itemsWithPricing = normalizedItems.map((it) => {
      const pItem = pricingMap.get(String(it.productId)) || null;
      return {
        ...it,
        pricing: pItem?.pricing || null,
        appliedDiscounts: pItem?.applied || null,
      };
    });

    const engineAppliedCode =
      pricing?.appliedAdmin?.priceDiscount?.codeType === "coupon"
        ? normalizeCouponCode(pricing?.appliedAdmin?.priceDiscount?.code)
        : "";

    return res.json({
      success: true,
      mode: "BUY_NOW",
      coupon: {
        requested: effectiveCouponCode || null,
        applied: engineAppliedCode || null,
      },
      items: itemsWithPricing,
      pricing,
      totals: {
        subtotal: Number(pricing?.totals?.subtotal ?? subtotal),
        discountedSubtotal: Number(pricing?.totals?.discountedSubtotal ?? subtotal),
        sellerDiscountTotal: Number(pricing?.totals?.sellerDiscountTotal ?? 0),
        adminDiscountTotal: Number(pricing?.totals?.adminDiscountTotal ?? 0),
        shippingFee: Number(pricing?.totals?.shippingFee ?? baseShippingFee),
        shippingDiscount: Number(pricing?.totals?.shippingDiscount ?? 0),
        grandTotal: Number(pricing?.totals?.grandTotal ?? subtotal + baseShippingFee),
        totalQuantity,
      },
    });
  } catch (err) {
    console.error("POST /api/orders/quote error:", err);
    return res
      .status(500)
      .json({ success: false, message: "Failed to compute order quote" });
  }
});

/* ===================================================
   SELLER COD "MARK PAID" ROUTES DISABLED
=================================================== */
router.patch("/:orderId/seller-payment-status", authMiddleware, async (req, res) => {
  return res.status(403).json({
    success: false,
    message: "Disabled: Sellers cannot update COD payment status. Admin only.",
  });
});

router.patch("/seller/:orderId/mark-cod-paid", authMiddleware, async (req, res) => {
  return res.status(403).json({
    success: false,
    message: "Disabled: Sellers cannot update COD payment status. Admin only.",
  });
});

/* ===================================================
   SELLER: INVOICE PDF (DOWNLOAD + PREVIEW)
=================================================== */
router.get("/seller/invoices/:invoiceId/pdf", authMiddleware, async (req, res) => {
  try {
    if (!ensureSeller(req, res)) return;

    const sellerIdStr = getSellerIdFromReq(req);
    const invoiceId = toObjectId(req.params.invoiceId);

    if (!invoiceId) {
      return res.status(400).json({ success: false, message: "Invalid invoiceId" });
    }

    const invoice = await Invoices.findOne({
      _id: invoiceId,
      sellerId: sellerIdStr,
    });
    if (!invoice) {
      return res.status(404).json({ success: false, message: "Invoice not found" });
    }

    const mode = normalizeStatus(req.query?.mode || "inline");
    const isDownload = mode === "download";
    const safeFile = safePdfFilename(
      safeString(req.query?.filename) ||
        safeString(invoice.invoiceNumber) ||
        "invoice"
    );

    const doc = new PDFDocument({ margin: 40 });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `${isDownload ? "attachment" : "inline"}; filename=${safeFile}.pdf`
    );

    doc.pipe(res);

    const money = (n) => {
      const x = Number(n || 0);
      try {
        return x.toLocaleString("en-NP", {
          minimumFractionDigits: 0,
          maximumFractionDigits: 2,
        });
      } catch {
        return String(x);
      }
    };

    const lineY = () => {
      const y = doc.y;
      doc
        .moveTo(40, y)
        .lineTo(doc.page.width - 40, y)
        .strokeColor("#e5e7eb")
        .stroke();
      doc.moveDown(0.8);
    };

    let header = invoice.header || {};
    let cfg = invoice.invoiceConfig || {};

    try {
      const sellerObjId = toObjectId(sellerIdStr);
      if (sellerObjId) {
        const merged = await loadSellerInvoiceConfig(sellerObjId);
        header = merged.header || header;
        cfg = merged.invoiceConfig || cfg;
      }
    } catch (err) {
      console.error("Invoice PDF config merge failed:", err);
    }

    const mergedCfg = {
      ...cfg,
      showLogoOnInvoice: cfg.showLogoOnInvoice ?? false,
      showGlamziLogo: cfg.showGlamziLogo ?? false,
      invoiceLogo: cfg.invoiceLogo || cfg.logoUrl || header.logoUrl || null,
      showStoreAddress: cfg.showStoreAddress !== false,
      showCustomerPhone: cfg.showCustomerPhone !== false,
      showTaxInfo: cfg.showTaxInfo !== false,
      taxLabel: cfg.taxLabel || "VAT",
      taxRate: cfg.taxRate ?? "",
      paymentDueDays: Number.isFinite(Number(cfg.paymentDueDays))
        ? Number(cfg.paymentDueDays)
        : 0,
      footerNote: cfg.footerNote || cfg.footerText || cfg.legalText || cfg.terms || "",
    };

    const toImageBuffer = (val) => {
      if (!val) return null;
      const m = String(val).match(/^data:image\/(png|jpe?g);base64,(.+)$/i);
      try {
        return Buffer.from(m ? m[2] : val, "base64");
      } catch {
        return null;
      }
    };

    const logoBuf = mergedCfg.showLogoOnInvoice ? toImageBuffer(mergedCfg.invoiceLogo) : null;
    const logoSize = 70;
    const startY = doc.y;

    if (logoBuf) {
      doc.image(logoBuf, doc.page.width - 40 - logoSize, startY, {
        fit: [logoSize, logoSize],
        align: "right",
      });
    } else if (mergedCfg.showGlamziLogo) {
      doc
        .fontSize(12)
        .fillColor("#ec4899")
        .text("Glamzi", doc.page.width - 110, startY, {
          width: 70,
          align: "right",
        });
    }

    doc.fillColor("#111827");
    doc.fontSize(18).text(header.storeName || "Invoice", { align: "left" });

    doc.moveDown(0.3);
    doc.fontSize(10).fillColor("#374151");

    if (header.storeAddress && mergedCfg.showStoreAddress) doc.text(String(header.storeAddress));
    const contactLine = [
      header.storeEmail ? `Email: ${header.storeEmail}` : "",
      mergedCfg.showCustomerPhone && header.storePhone ? `Phone: ${header.storePhone}` : "",
    ]
      .filter(Boolean)
      .join(" | ");
    if (contactLine) doc.text(contactLine);
    if (mergedCfg.showTaxInfo && header.taxId)
      doc.text(`${mergedCfg.taxLabel || "VAT"} No: ${header.taxId}`);

    doc.moveDown(0.6);
    lineY();

    const invDate = invoice.invoiceDate ? new Date(invoice.invoiceDate) : null;

    const paymentMethodLabel = (invoice.paymentMethod || invoice.payment?.method || "-")
      .toString()
      .toUpperCase();
    const paymentStatusLabel = (invoice.paymentStatus || invoice.payment?.status || "pending")
      .toString()
      .toUpperCase();

    doc.fontSize(10).fillColor("#111827");
    doc.text(`Invoice #: ${invoice.invoiceNumber || "-"}`);
    if (invoice.orderNumber) doc.text(`Order #: ${invoice.orderNumber}`);
    doc.text(`Date: ${invDate ? invDate.toLocaleDateString() : "-"}`);
    doc.text(`Status: ${(invoice.status || "issued").toUpperCase()}`);
    doc.text(`Payment: ${paymentMethodLabel}`);
    doc.text(`Payment Status: ${paymentStatusLabel}`);
    if (mergedCfg.paymentDueDays > 0) doc.text(`Terms: Net ${mergedCfg.paymentDueDays} days`);

    doc.moveDown(0.8);

    doc.fontSize(12).fillColor("#111827").text("Bill To", { underline: true });
    doc.moveDown(0.3);
    doc.fontSize(10).fillColor("#374151");
    doc.text(invoice.customer?.name || "-");
    if (mergedCfg.showCustomerPhone && invoice.customer?.phone) doc.text(invoice.customer.phone);
    if (invoice.customer?.email) doc.text(invoice.customer.email);

    if (invoice.shippingAddress) {
      const sa = invoice.shippingAddress;
      const addrParts = [
        sa.tole || sa.addressLine1 || "",
        sa.municipalityName || sa.city || "",
        sa.district || "",
        sa.province || "",
        sa.wardNumber ? `Ward ${sa.wardNumber}` : "",
      ].filter(Boolean);
      if (addrParts.length) {
        doc.moveDown(0.2);
        doc.text(`Ship To: ${addrParts.join(", ")}`);
      }
    }

    doc.moveDown(0.8);
    lineY();

    doc.fontSize(12).fillColor("#111827").text("Items", { underline: true });
    doc.moveDown(0.6);

    const startX = 40;
    const rightX = doc.page.width - 40;

    const colNo = startX;
    const colItem = startX + 30;
    const colQty = rightX - 170;
    const colRate = rightX - 110;

    doc.fontSize(9).fillColor("#6b7280");
    doc.text("#", colNo, doc.y, { width: 25 });
    doc.text("Description", colItem, doc.y, { width: colQty - colItem - 10 });
    doc.text("Qty", colQty, doc.y, { width: 40, align: "right" });
    doc.text("Rate", colRate, doc.y, { width: 70, align: "right" });
    doc.text("Amount", rightX - 70, doc.y, { width: 70, align: "right" });
    doc.moveDown(0.4);

    doc
      .moveTo(startX, doc.y)
      .lineTo(rightX, doc.y)
      .strokeColor("#e5e7eb")
      .stroke();
    doc.moveDown(0.5);

    doc.fontSize(10).fillColor("#111827");

    let computedSubtotal = 0;

    (invoice.items || []).forEach((item, idx) => {
      const qty = Math.max(1, Number(item.quantity || 1));
      const lineFinal = Number(item?.pricing?.final ?? 0);
      const unitFinal =
        qty > 0
          ? lineFinal / qty
          : Number(item?.pricing?.final ?? item?.pricing?.net ?? item?.price ?? 0);

      const amount = lineFinal || unitFinal * qty;
      computedSubtotal += amount;

      const y = doc.y;
      doc.text(String(idx + 1), colNo, y, { width: 25 });

      const title = item.title || item.name || "Item";
      doc.text(String(title), colItem, y, { width: colQty - colItem - 10 });

      doc.text(String(qty), colQty, y, { width: 40, align: "right" });
      doc.text(money(unitFinal), colRate, y, { width: 70, align: "right" });
      doc.text(money(amount), rightX - 70, y, { width: 70, align: "right" });

      doc.moveDown(0.6);
    });

    doc.moveDown(0.3);
    lineY();

    // Customer-facing totals: use orderTotals snapshot if present, else computed.
    const orderTotals = invoice.orderTotals || {};
    const subtotal =
      Number(orderTotals.discountedSubtotal ?? orderTotals.subtotal ?? 0) ||
      Number(orderTotals.grandTotal ?? 0) ||
      Number(computedSubtotal || 0);

    const shippingFee = Number(orderTotals.shippingFee ?? 0);
    const shippingDiscount = Number(orderTotals.shippingDiscount ?? 0);

    const sellerDiscountTotal = Number(orderTotals.sellerDiscountTotal ?? 0);
    const adminDiscountTotal = Number(orderTotals.adminDiscountTotal ?? 0);

    const taxRateNum = Number(mergedCfg.taxRate) || 0;
    const taxAmount =
      mergedCfg.showTaxInfo && taxRateNum > 0 ? (subtotal * taxRateNum) / 100 : 0;

    const grandTotal = Math.max(
      0,
      subtotal + shippingFee - shippingDiscount + taxAmount
    );

    doc.fontSize(10).fillColor("#111827");
    doc.text(`Subtotal: NPR ${money(subtotal)}`, { align: "right" });

    if (sellerDiscountTotal) {
      doc.text(`Seller Discount: -NPR ${money(sellerDiscountTotal)}`, { align: "right" });
    }
    if (adminDiscountTotal) {
      doc.text(`Admin Discount: -NPR ${money(adminDiscountTotal)}`, { align: "right" });
    }
    if (shippingFee) doc.text(`Shipping: NPR ${money(shippingFee)}`, { align: "right" });
    if (shippingDiscount) {
      doc.text(`Shipping Discount: -NPR ${money(shippingDiscount)}`, { align: "right" });
    }
    if (taxAmount > 0) {
      doc.text(
        `${mergedCfg.taxLabel || "VAT"} (${taxRateNum}%): NPR ${money(taxAmount)}`,
        { align: "right" }
      );
    }

    doc.moveDown(0.2);
    doc.fontSize(12).text(`Total: NPR ${money(grandTotal)}`, { align: "right" });

    const footerText =
      safeString(mergedCfg.footerNote) ||
      safeString(cfg.footerText) ||
      safeString(cfg.legalText) ||
      safeString(cfg.terms) ||
      "";
    if (footerText) {
      doc.moveDown(1);
      lineY();
      doc.fontSize(9).fillColor("#6b7280").text(footerText, { align: "left" });
    }

    doc.end();
  } catch (err) {
    console.error("Invoice PDF error:", err);
    res.status(500).json({
      success: false,
      message: "Failed to generate invoice PDF",
    });
  }
});

/* ===================================================
   CUSTOMER: CREATE ORDER (WITH DISCOUNTS + COUPON)
=================================================== */
router.post("/", authMiddleware, async (req, res) => {
  try {
    if (!ensureCustomer(req, res)) return;

    const userIdStr = getAuthUserId(req);
    const userObjId = toObjectId(userIdStr);
    if (!userObjId) {
      return res
        .status(401)
        .json({ success: false, message: "Invalid user session" });
    }

    const mode = safeString(req.body?.mode || "CART").toUpperCase();
    const paymentMethod = normalizeStatus(req.body?.paymentMethod || "cod");
    const shippingAddress = req.body?.shippingAddress || null;

    if (!shippingAddress) {
      return res
        .status(400)
        .json({ success: false, message: "Shipping address is required" });
    }

    if (!["cod", "online", "esewa"].includes(paymentMethod)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid payment method" });
    }

    const explicitCoupon = normalizeCouponCode(req.body?.couponCode);
    const cartForCoupon = await getCartByUserId(userIdStr);
    const cartCoupon = normalizeCouponCode(cartForCoupon?.adminCoupon?.code);
    const effectiveCouponCode = explicitCoupon || cartCoupon || "";

    let requestItems = Array.isArray(req.body?.items) ? req.body.items : [];
    let cart = null;

    if (mode === "CART") {
      cart = cartForCoupon || (await getCartByUserId(userIdStr));
      const cartItems = Array.isArray(cart?.items) ? cart.items : [];
      if (!cartItems.length) {
        return res
          .status(400)
          .json({ success: false, message: "Your cart is empty" });
      }
      requestItems = cartItems.map((it) => ({
        productId: it.productId,
        quantity: it.quantity,
      }));
    } else {
      if (!Array.isArray(requestItems) || requestItems.length === 0) {
        return res
          .status(400)
          .json({ success: false, message: "Order items are required" });
      }
    }

    const normalizedItems = [];
    let subtotal = 0;
    let totalQuantity = 0;
    const reservationMap = new Map();
    const reservationPayload = Array.isArray(req.body?.reservations) ? req.body.reservations : [];
    reservationPayload.forEach((r) => {
      if (r?.productId && r?.reservationId) {
        reservationMap.set(String(r.productId), String(r.reservationId));
      }
    });
    const commitReservations = [];

    const ids = requestItems
      .map((x) => toObjectId(x?.productId || x?.product?._id))
      .filter(Boolean);

    if (!ids.length) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid productId in items" });
    }

    const prods = await Products.find({ _id: { $in: ids } }).toArray();
    const pMap = new Map(prods.map((p) => [String(p._id), p]));

    for (const line of requestItems) {
      const pid = line?.productId || line?.product?._id;
      const productId = toObjectId(pid);
      if (!productId) {
        return res
          .status(400)
          .json({ success: false, message: "Invalid productId in items" });
      }

      const product = pMap.get(String(productId));
      if (!product) {
        return res
          .status(404)
          .json({ success: false, message: "Product not found in items" });
      }

      const quantity = Math.max(1, Math.floor(Number(line.quantity) || 1));
      const reservationId =
        line?.reservationId || reservationMap.get(String(productId)) || null;
      const price = Number(product.price) || 0;

      subtotal += price * quantity;
      totalQuantity += quantity;

      const sellerId = product.userId ? String(product.userId) : null;
      if (!sellerId) {
        return res.status(400).json({
          success: false,
          message: "Product missing seller mapping (userId).",
        });
      }

      const categoryId =
        product?.categoryId?.toString?.() ||
        product?.categoryId ||
        product?.category?._id?.toString?.() ||
        product?.category?._id ||
        product?.category ||
        null;

      normalizedItems.push({
        productId: product._id,
        title: product.title || product.name || "Untitled",
        price,
        quantity,
        sellerId: String(sellerId),
        categoryId: categoryId ? String(categoryId) : null,
        image: product.image || product.images?.[0] || null,
        reservationId,
      });
    }

    // Validate flash reservations for items in active flash
    if (normalizedItems.length > 0) {
      const now = new Date();
      const pidStrings = normalizedItems.map((it) => String(it.productId));
      const pidOids = pidStrings.filter((s) => ObjectId.isValid(s)).map((s) => new ObjectId(s));

      const flashDocs = await Discounts.find({
        saleType: "flash",
        status: "active",
        $and: [
          {
            $or: [{ startAt: { $exists: false } }, { startAt: { $lte: now } }, { startAt: null }],
          },
          {
            $or: [{ endAt: { $exists: false } }, { endAt: { $gte: now } }, { endAt: null }],
          },
        ],
        $or: [{ productIds: { $in: pidOids } }, { productIds: { $in: pidStrings } }],
      }).toArray();

      const productInFlash = (doc, pid) => {
        const arr = Array.isArray(doc?.productIds) ? doc.productIds.map(String) : [];
        return arr.includes(String(pid));
      };

      for (const it of normalizedItems) {
        const flashDoc = flashDocs.find((d) => productInFlash(d, it.productId));
        if (!flashDoc) continue;

        if (!it.reservationId) {
          return res
            .status(400)
            .json({ success: false, message: "Flash reservation required for this product" });
        }

        const rid = toObjectId(it.reservationId);
        if (!rid) {
          return res
            .status(400)
            .json({ success: false, message: "Invalid flash reservation id" });
        }

        const reservation = await FlashReservations.findOne({ _id: rid });
        if (!reservation) {
          return res.status(404).json({ success: false, message: "Reservation not found" });
        }
        if (String(reservation.userId) !== String(userIdStr)) {
          return res.status(403).json({ success: false, message: "Reservation forbidden" });
        }
        if (reservation.status !== "held") {
          return res
            .status(400)
            .json({ success: false, message: "Reservation not in held status" });
        }
        if (reservation.expiresAt && now > new Date(reservation.expiresAt)) {
          return res.status(400).json({ success: false, message: "Reservation expired" });
        }
        if (
          String(reservation.productId) !== String(it.productId) ||
          String(reservation.discountId) !== String(flashDoc._id)
        ) {
          return res
            .status(400)
            .json({ success: false, message: "Reservation does not match flash/product" });
        }
        if (Number(reservation.qty || 0) < Number(it.quantity || 1)) {
          return res.status(400).json({ success: false, message: "Reservation qty too low" });
        }

        commitReservations.push({
          reservationId: rid,
          discountId: flashDoc._id,
          qty: it.quantity,
        });

        it.flashDiscountId = flashDoc._id;
      }
    }

    const providedShipping = Number(req.body?.totals?.shippingFee);
    let baseShippingFee = Number.isFinite(providedShipping) ? providedShipping : NaN;
    if (Number.isNaN(baseShippingFee)) baseShippingFee = subtotal > 3000 ? 0 : 150;
    baseShippingFee = Math.max(0, Number(baseShippingFee || 0));

    const discountCartInput = {
      items: normalizedItems.map((it) => ({
        productId: String(it.productId),
        sellerId: String(it.sellerId),
        categoryId: it.categoryId ? String(it.categoryId) : null,
        price: Number(it.price || 0),
        quantity: Number(it.quantity || 1),
      })),
      shippingFee: baseShippingFee,
    };

    const pricing = await applyDiscounts(discountCartInput, {
      db,
      couponCode: effectiveCouponCode,
    });

    const finalTotals = pricing?.totals || {};
    const now = new Date();

    const sellerFulfillment = {};
    for (const it of normalizedItems) {
      const sid = String(it.sellerId);
      if (!sellerFulfillment[sid]) {
        sellerFulfillment[sid] = {
          status: "created",
          createdAt: now,
          updatedAt: now,
          updatedBy: "system",
          timeline: { createdAt: now },
          paymentStatus: "pending",
          paidAt: null,
          paidBy: null,
        };
      }
    }

    const sellerPayments = {};
    for (const sid of Object.keys(sellerFulfillment || {})) {
      sellerPayments[sid] = {
        status: "pending",
        paidAt: null,
        paidBy: null,
        updatedAt: now,
      };
    }

    const overallStatus = deriveOverallStatus(sellerFulfillment);

    const orderNumber =
      safeString(req.body?.orderNumber) ||
      `ORD-${Date.now()}-${Math.floor(Math.random() * 900 + 100)}`;

    const engineAppliedCode =
      pricing?.appliedAdmin?.priceDiscount?.codeType === "coupon"
        ? normalizeCouponCode(pricing?.appliedAdmin?.priceDiscount?.code)
        : "";

    const pricingItems = Array.isArray(pricing?.items) ? pricing.items : [];
    const pricingMap = new Map(pricingItems.map((x) => [String(x.productId), x]));

    const orderItems = normalizedItems.map((it) => {
      const pItem = pricingMap.get(String(it.productId)) || null;
      return {
        ...it,
        pricing: pItem?.pricing || null,
        appliedDiscounts: pItem?.applied || null,
        flashDiscountId: it.flashDiscountId ? String(it.flashDiscountId) : null,
        flashReservationId: it.reservationId || null,
      };
    });

    let couponReservation = { reserved: false, doc: null };
    let insertedId = null;
    let orderDocOut = null;

    const cartSubtotalForCoupon = Number(finalTotals.subtotal ?? subtotal);

    const session = client.startSession();
    try {
      await session.withTransaction(async () => {
        if (engineAppliedCode) {
          const info = await reserveAdminCouponOrNull({
            couponCode: engineAppliedCode,
            userIdStr: userIdStr,
            orderNumber,
            cartSubtotal: cartSubtotalForCoupon,
            db,
            session,
          });

          if (!info) {
            const e = new Error("Coupon could not be reserved");
            e.statusCode = 400;
            throw e;
          }

          const did = toObjectId(info.discountId);
          const reservedDoc = did
            ? await Discounts.findOne({ _id: did }, { session })
            : null;

          couponReservation = { reserved: true, doc: reservedDoc };
        }

        let couponSnapshot = null;
        if (couponReservation?.reserved && couponReservation?.doc) {
          const d = couponReservation.doc;
          couponSnapshot = {
            discountId: d?._id ? String(d._id) : null,
            code: normalizeCouponCode(d?.code),
            authority: safeString(d?.authority || "admin").toLowerCase(),
            codeType: normalizeCodeType(d),
            kind: safeString(d?.kind || d?.discountType || "").toLowerCase() || null,
            value: Number(d?.value || 0),
            maxDiscount: d?.maxDiscount ?? null,
            minCartSubtotal: d?.minCartSubtotal ?? null,
            priority: d?.priority ?? null,
            stackableWithFreeShipping: !!d?.stackableWithFreeShipping,
            startAt: d?.startAt ?? d?.startsAt ?? null,
            endAt: d?.endAt ?? d?.endsAt ?? null,
            reservedAt: now,
          };
        }

        const initialPaymentStatus =
          paymentMethod === "cod"
            ? "pending"
            : paymentMethod === "esewa"
            ? "paid"
            : "initiated";

        const orderDoc = {
          userId: userObjId,
          mode,
          items: orderItems,
          paymentMethod, // "cod" | "online" | "esewa"
          paymentStatus: initialPaymentStatus,
          payment: {
            method: paymentMethod,
            status: initialPaymentStatus,
          },
          totals: {
            subtotal: Number(finalTotals.subtotal ?? subtotal),
            discountedSubtotal: Number(finalTotals.discountedSubtotal ?? subtotal),
            sellerDiscountTotal: Number(finalTotals.sellerDiscountTotal ?? 0),
            adminDiscountTotal: Number(finalTotals.adminDiscountTotal ?? 0),
            shippingFee: Number(finalTotals.shippingFee ?? baseShippingFee),
            shippingDiscount: Number(finalTotals.shippingDiscount ?? 0),
            grandTotal: Number(finalTotals.grandTotal ?? subtotal + baseShippingFee),
            totalQuantity,
          },
          discounts: {
            couponCode: engineAppliedCode || null,
            appliedAdmin: pricing?.appliedAdmin || null,
            couponReservation: couponReservation.reserved
              ? {
                  discountId: couponReservation.doc?._id
                    ? String(couponReservation.doc._id)
                    : null,
                  reservedAt: now,
                }
              : null,
            couponSnapshot: couponSnapshot || null,
          },
          shippingAddress,
          orderNumber,
          status: overallStatus,
          sellerFulfillment,
          sellerPayments,
          paidAt: null,
          paidBy: null,
          createdAt: now,
          updatedAt: now,
        };

        const ins = await Orders.insertOne(orderDoc, { session });
        insertedId = ins.insertedId;
        orderDocOut = orderDoc;
      });
    } finally {
      await session.endSession();
    }

    if (insertedId && orderDocOut && !orderDocOut._id) {
      orderDocOut._id = insertedId;
    }

    // NOTE: This COD invoice snapshot is legacy; keep it embedded on the order only.
    if (orderDocOut?.paymentMethod === "cod" && insertedId) {
      const codInvoiceDoc = buildCodInvoiceSnapshot(orderDocOut);
      await Orders.updateOne({ _id: insertedId }, { $set: { codInvoice: codInvoiceDoc } });
      orderDocOut.codInvoice = codInvoiceDoc;
    }

    if (insertedId && orderDocOut?.items?.length) {
      const uniqueSellerIds = Array.from(
        new Set(
          orderDocOut.items
            .map((item) => item?.sellerId || item?.seller?._id || item?.seller?.id || null)
            .filter(Boolean)
            .map((id) => String(id))
        )
      );

      for (const sellerId of uniqueSellerIds) {
        try {
          await enqueueNotification("seller", {
            sellerId,
            type: "order_new",
            title: "New order received",
            body: `You have a new order ${orderDocOut.orderNumber || ""}`.trim(),
            link: "/seller/dashboard/orders/orderslisting",
            meta: { orderId: String(insertedId), orderNumber: orderDocOut.orderNumber || "" },
          });
        } catch (notifyErr) {
          console.error("Seller order notification error:", notifyErr);
        }
      }
    }

    // Customer in-app notification (order placed) -> outbox
    try {
      await enqueueNotification("customer", {
        customerId: orderDocOut.userId,
        orderId: insertedId,
        orderNumber: orderDocOut.orderNumber || null,
        type: "order_placed",
        title: "Order placed successfully",
        body: `Your order ${orderDocOut.orderNumber || ""} has been placed.`.trim(),
        link: "/orders",
        meta: { orderId: String(insertedId) },
      });
    } catch (notifyErr) {
      console.error("Customer order notification error:", notifyErr);
    }

    // Commit flash reservations (move reserved -> sold)
    if (insertedId && commitReservations.length > 0) {
      const commitNow = new Date();
      for (const r of commitReservations) {
        const did = r.discountId instanceof ObjectId ? r.discountId : toObjectId(r.discountId);
        if (did) {
          await Discounts.updateOne(
            { _id: did },
            {
              $inc: { reservedQty: -Math.abs(r.qty), soldQty: Math.abs(r.qty) },
              $set: { updatedAt: commitNow },
            }
          );
        }
        await FlashReservations.updateOne(
          { _id: r.reservationId },
          {
            $set: {
              status: "committed",
              updatedAt: commitNow,
              committedAt: commitNow,
              orderId: insertedId,
            },
          }
        );
      }
    }

    if (mode === "CART") {
      const cartToClear = cart || (await getCartByUserId(userIdStr));
      if (cartToClear?._id) {
        await Carts.updateOne(
          { _id: cartToClear._id },
          {
            $set: {
              items: [],
              totals: {
                subtotal: 0,
                shippingFee: 0,
                grandTotal: 0,
                totalQuantity: 0,
              },
              updatedAt: new Date(),
            },
            $unset: { adminCoupon: "" },
          }
        );
      }
    }

    if (orderDocOut?.items?.length > 0) {
      const bulkOps = orderDocOut.items.map((item) => ({
        updateOne: {
          filter: { _id: toObjectId(item.productId) },
          update: {
            $inc: {
              quantity: -(Number(item.quantity) || 1),
              soldCount: Number(item.quantity) || 1,
            },
            $set: { updatedAt: new Date() },
          },
        },
      }));
      try {
        await Products.bulkWrite(bulkOps, { ordered: false });
        console.log(`[Orders] Updated stock/soldCount for ${bulkOps.length} products`);
      } catch (stockErr) {
        console.error("[Orders] Failed to update product stock:", stockErr);
      }
    }

    return res.status(201).json({
      success: true,
      message: "Order created successfully",
      order: { _id: insertedId, ...orderDocOut },
    });
  } catch (err) {
    console.error("POST /api/orders error:", err);

    const sc = Number(err?.statusCode || err?.status || 0);
    if (sc >= 400 && sc < 500) {
      return res.status(sc).json({ success: false, message: err.message || "Order failed" });
    }

    return res.status(500).json({ success: false, message: "Failed to create order" });
  }
});

/* ===================================================
   CUSTOMER: MY ORDERS
=================================================== */
router.get("/my", authMiddleware, async (req, res) => {
  try {
    const userId = getAuthUserId(req);
    const userObjId = toObjectId(userId);
    if (!userObjId) {
      return res.status(401).json({ success: false, message: "Invalid user session" });
    }

    const orders = await Orders.find({ userId: userObjId })
      .sort({ createdAt: -1 })
      .toArray();
    return res.json({ success: true, orders });
  } catch (err) {
    console.error("GET /api/orders/my error:", err);
    return res.status(500).json({ success: false, message: "Failed to load orders" });
  }
});

/* ===================================================
   SELLER: BULK STATUS UPDATE (PER-SELLER)
=================================================== */
router.patch("/seller/status", authMiddleware, async (req, res) => {
  try {
    if (!ensureSeller(req, res)) return;

    const sellerIdStr = getSellerIdFromReq(req);
    const sellerIdObj = await resolveSellerObjectId(req);

    if (!sellerIdStr || !sellerIdObj) {
      return res.status(400).json({ success: false, message: "Invalid seller id" });
    }

    const { orderIds = [], nextStatus, meta = {} } = req.body;

    if (!Array.isArray(orderIds) || orderIds.length === 0) {
      return res.status(400).json({
        success: false,
        message: "orderIds array is required",
      });
    }

    const target = normalizeStatus(nextStatus);
    if (!target) {
      return res.status(400).json({ success: false, message: "nextStatus is required" });
    }

    if (!sellerCanSetStatus(target)) {
      return res.status(403).json({
        success: false,
        message:
          "Seller can only update orders up to Shipped. Delivered/Completed is Admin responsibility.",
      });
    }

    const objectIds = orderIds.map((id) => toObjectId(id)).filter(Boolean);
    if (objectIds.length === 0) {
      return res.status(400).json({
        success: false,
        message: "No valid orderIds provided",
      });
    }

    const now = new Date();
    const updatedOrders = [];
    const issuedInvoices = [];
    const errors = [];

    for (const oid of objectIds) {
      const order = await Orders.findOne({
        _id: oid,
        "items.sellerId": sellerIdStr,
      });
      if (!order) {
        errors.push({ orderId: String(oid), message: "Order not found for this seller" });
        continue;
      }

      const sellerPath = `sellerFulfillment.${sellerIdStr}`;
      const current = normalizeStatus(order?.sellerFulfillment?.[sellerIdStr]?.status || "created");
      const isReturnFlow = isActiveReturnFlow(order);

      if (!canTransition(current, target)) {
        errors.push({ orderId: String(oid), message: `Invalid transition: ${current} → ${target}` });
        continue;
      }

      if (target === "ready_to_ship" && isReturnFlow) {
        errors.push({
          orderId: String(oid),
          message: "ready_to_ship is only for regular fulfillment. Use return workflows instead.",
        });
        continue;
      }

      if (isReturnFlow && target === "shipped") {
        errors.push({
          orderId: String(oid),
          message: "Return flow active; use the return workflow instead of shipping.",
        });
        continue;
      }

      if (target === "shipped" && !isReturnFlow) {
        const existingTracking = safeString(
          order?.sellerFulfillment?.[sellerIdStr]?.shipping?.trackingNumber
        );
        const incomingTracking = safeString(meta?.trackingNumber);

        if (!existingTracking && !incomingTracking) {
          errors.push({
            orderId: String(oid),
            message: "Tracking number is required to mark shipped.",
          });
          continue;
        }
      }

      const $set = {
        [`${sellerPath}.status`]: target,
        [`${sellerPath}.updatedAt`]: now,
        [`${sellerPath}.updatedBy`]: "seller",
      };

      const tsKey = timestampFieldForStatus(target);
      if (tsKey) $set[`${sellerPath}.timeline.${tsKey}`] = now;

      if (target === "shipped") {
        const courier = String(meta?.courier || "").trim();
        const trackingNumber = String(meta?.trackingNumber || "").trim();
        if (courier) $set[`${sellerPath}.shipping.courier`] = courier;
        if (trackingNumber) $set[`${sellerPath}.shipping.trackingNumber`] = trackingNumber;
        $set[`${sellerPath}.shipping.updatedAt`] = now;
      }

      await Orders.updateOne({ _id: oid }, { $set });

      if (target === "ready_to_ship" && !isReturnFlow) {
        try {
          // Persist deterministic “queued” state for Ops/Seller UI
          await markShippingBookingQueued({
            Orders,
            orderId: String(oid),
            sellerIdStr,
          });

          bookShipmentFireAndForget({
            orderId: String(oid),
            sellerId: sellerIdStr,
            reason: "ready_to_ship",
          });
        } catch (e) {
          console.error("[shipping][fire] enqueue failed:", e?.message || e);

          // Optional: capture one failed attempt entry immediately (best-effort)
          try {
            await appendShippingBookingAttempt({
              Orders,
              orderId: String(oid),
              sellerIdStr,
              attempt: 1,
              ok: false,
              httpStatus: null,
              code: "enqueue_failed",
              message: String(e?.message || e),
              durationMs: null,
              shipmentId: null,
              trackingNumber: null,
            });
          } catch (logErr) {
            console.error("[shipping][log] append attempt failed:", logErr?.message || logErr);
          }
        }
      }

      const after = await Orders.findOne({ _id: oid });
      const overall = deriveOverallStatus(after?.sellerFulfillment || {});
      await Orders.updateOne({ _id: oid }, { $set: { status: overall, updatedAt: now } });

      if (target === "shipped") {
        try {
          const out = await issueInvoiceForSellerOrder({
            sellerIdStr,
            sellerIdObj,
            order: after || order,
          });
          if (out?.ok) {
            issuedInvoices.push({
              orderId: String(oid),
              created: !!out.created,
              invoiceId: out.invoice?._id ? String(out.invoice._id) : null,
              invoiceNumber: out.invoice?.invoiceNumber || null,
            });
          } else {
            errors.push({ orderId: String(oid), message: out?.message || "Failed to issue invoice" });
          }
        } catch (e) {
          console.error("Auto-issue invoice (bulk) error:", e);
          errors.push({ orderId: String(oid), message: "Auto invoice issuance failed" });
        }
      }

      updatedOrders.push(String(oid));
    }

    return res.json({ success: true, updatedOrders, issuedInvoices, errors });
  } catch (err) {
    console.error("PATCH /api/orders/seller/status error:", err);
    return res
      .status(500)
      .json({ success: false, message: "Failed to update seller status" });
  }
});

/* ===================================================
   SELLER: ORDERS LIST
=================================================== */
router.get("/seller", authMiddleware, async (req, res) => {
  try {
    if (!ensureSeller(req, res)) return;

    const sellerIdStr = getSellerIdFromReq(req);
    if (!sellerIdStr) {
      return res.status(401).json({ success: false, message: "Invalid seller session" });
    }

    const { status = "", q = "", page = "1", limit = "20" } = req.query;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(10, parseInt(limit, 10) || 20));
    const skip = (pageNum - 1) * limitNum;

    const statusFilter = normalizeStatus(status);
    const hasStatus = !!statusFilter;

    const keyword = safeString(q);
    const rx = keyword ? new RegExp(escapeRegex(keyword), "i") : null;

    const match = { items: { $elemMatch: { sellerId: sellerIdStr } } };

    const pipeline = [
      { $match: match },
      {
        $addFields: {
          sellerSegment: {
            $ifNull: [
              {
                $getField: {
                  field: sellerIdStr,
                  input: { $ifNull: ["$sellerFulfillment", {}] },
                },
              },
              { status: "created" },
            ],
          },
          sellerPaymentSegment: {
            $ifNull: [
              {
                $getField: {
                  field: sellerIdStr,
                  input: { $ifNull: ["$sellerPayments", {}] },
                },
              },
              { status: "pending", paidAt: null, paidBy: null },
            ],
          },
        },
      },
      {
        $addFields: {
          sellerStatus: {
            $toLower: { $ifNull: ["$sellerSegment.status", "created"] },
          },
          sellerPaymentStatus: {
            $toLower: { $ifNull: ["$sellerPaymentSegment.status", "pending"] },
          },
          sellerPaidAt: { $ifNull: ["$sellerPaymentSegment.paidAt", null] },
          sellerPaidBy: { $ifNull: ["$sellerPaymentSegment.paidBy", null] },
        },
      },
      ...(hasStatus ? [{ $match: { sellerStatus: statusFilter } }] : []),
      {
        $addFields: {
          sellerItems: {
            $filter: {
              input: "$items",
              as: "it",
              cond: { $eq: ["$$it.sellerId", sellerIdStr] },
            },
          },
          customerName: {
            $ifNull: ["$shippingAddress.fullName", { $ifNull: ["$customerName", ""] }],
          },
          customerPhone: {
            $ifNull: ["$shippingAddress.phone", { $ifNull: ["$customerPhone", ""] }],
          },
        },
      },
      ...(rx
        ? [
            {
              $match: {
                $or: [{ orderNumber: rx }, { invoiceNumber: rx }, { customerName: rx }, { customerPhone: rx }],
              },
            },
          ]
        : []),
      { $sort: { createdAt: -1, _id: -1 } },
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
                updatedAt: 1,
                status: 1,
                sellerStatus: 1,
                totals: 1,
                paymentMethod: 1,
                paymentStatus: 1,
                sellerPaymentStatus: 1,
                sellerPaidAt: 1,
                sellerPaidBy: 1,
                shippingAddress: 1,
                sellerItems: 1,
                sellerSegment: 1,
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

    const orderIdStrings = rows.map((o) => String(o._id || "")).filter(Boolean);
    const invoiceMap = new Map();

    if (orderIdStrings.length) {
      const invoices = await Invoices.find(
        { sellerId: sellerIdStr, orderId: { $in: orderIdStrings } },
        { projection: { orderId: 1, invoiceNumber: 1, status: 1 } }
      ).toArray();

      for (const inv of invoices) {
        invoiceMap.set(String(inv.orderId), {
          invoiceId: String(inv._id || ""),
          invoiceNumber: inv.invoiceNumber || null,
          status: inv.status || null,
        });
      }
    }

    const orders = rows.map((o) => {
      const sellerSegment = o.sellerSegment || null;
      const shippingInfo = sellerSegment?.shipping || null;
      const oid = String(o._id || "");
      const invoice = oid ? invoiceMap.get(oid) || null : null;

      return {
        ...o,
        overallStatus: normalizeStatus(o.status || "created"),
        sellerStatus: normalizeStatus(o.sellerStatus || "created"),
        allowedNextStatuses: getAllowedNextStatuses(o.sellerStatus || "created"),
        sellerPaymentStatus: normalizeStatus(o.sellerPaymentStatus || "pending"),
        paymentStatus: normalizeStatus(o.paymentStatus || "pending"),
        sellerMeta: sellerSegment
          ? { ...sellerSegment, shipping: shippingInfo }
          : null,
        shippingInfo,
        invoice,
        hasInvoice: !!invoice,
        sellerSegment: undefined,
      };
    });

    return res.json({
      success: true,
      orders,
      pagination: { page: pageNum, pages, total },
    });
  } catch (err) {
    console.error("GET /api/orders/seller error:", err);
    return res
      .status(500)
      .json({ success: false, message: "Failed to load seller orders" });
  }
});

/* ===================================================
   SELLER: PER-ORDER STATUS TRANSITION
=================================================== */
router.patch("/:orderId/seller-status", authMiddleware, async (req, res) => {
  try {
    if (!ensureSeller(req, res)) return;

    const orderIdentifier = req.params.orderId;
    let orderId = toObjectId(orderIdentifier);
    if (!orderId) {
      // Try to resolve by orderNumber when a raw objectId wasn't provided
      const orderByNumber = await Orders.findOne({ orderNumber: orderIdentifier });
      if (orderByNumber) {
        orderId = orderByNumber._id;
      } else {
        return res.status(400).json({ success: false, message: "Invalid orderId" });
      }
    }

    const sellerIdStr = getSellerIdFromReq(req);
    const sellerIdObj = await resolveSellerObjectId(req);
    if (!sellerIdStr || !sellerIdObj) {
      return res.status(401).json({ success: false, message: "Invalid seller session" });
    }

    const nextStatus = normalizeStatus(req.body?.nextStatus);
    if (!nextStatus) {
      return res.status(400).json({ success: false, message: "nextStatus is required" });
    }

    if (!sellerCanSetStatus(nextStatus)) {
      return res.status(403).json({
        success: false,
        message:
          "Seller can only update orders up to Shipped. Delivered/Completed is Admin responsibility.",
      });
    }

    const order = await Orders.findOne({
      _id: orderId,
      items: { $elemMatch: { sellerId: sellerIdStr } },
    });

    if (!order) {
      return res.status(404).json({ success: false, message: "Order not found for this seller" });
    }

    const isReturnFlow =
      Boolean(req.body?.returnFlow) || Boolean(req.body?.isReturnFlow) || isActiveReturnFlow(order);

    const currentSellerStatus = normalizeStatus(
      order?.sellerFulfillment?.[sellerIdStr]?.status || "created"
    );

    if (!canTransition(currentSellerStatus, nextStatus)) {
      return res.status(400).json({
        success: false,
        message: `Invalid seller transition: ${currentSellerStatus} → ${nextStatus}`,
      });
    }

    if (nextStatus === "ready_to_ship" && isReturnFlow) {
      return res.status(400).json({
        success: false,
        message: "ready_to_ship is only for regular fulfillment. Use return workflows instead.",
      });
    }

    if (nextStatus === "shipped") {
      const existingTracking = safeString(
        order?.sellerFulfillment?.[sellerIdStr]?.shipping?.trackingNumber
      );
      const incomingTracking = safeString(req.body?.shipping?.trackingNumber);
      if (!existingTracking && !incomingTracking) {
        return res.status(400).json({
          success: false,
          message: "Tracking number is required to mark shipped.",
        });
      }
    }

    const now = new Date();
    const actor = getActorId(req);

    const sellerPath = `sellerFulfillment.${sellerIdStr}`;
    const tsField = timestampFieldForStatus(nextStatus);

    const $set = {
      updatedAt: now,
      [`${sellerPath}.status`]: nextStatus,
      [`${sellerPath}.updatedAt`]: now,
      [`${sellerPath}.updatedBy`]: actor,
    };

    if (tsField) $set[`${sellerPath}.timeline.${tsField}`] = now;

    if (nextStatus === "shipped" && req.body?.shipping) {
      const courier = safeString(req.body.shipping?.courier);
      const trackingNumber = safeString(req.body.shipping?.trackingNumber);

      if (courier) $set[`${sellerPath}.shipping.courier`] = courier;
      if (trackingNumber) $set[`${sellerPath}.shipping.trackingNumber`] = trackingNumber;
      $set[`${sellerPath}.shipping.updatedAt`] = now;
    }

    await Orders.updateOne({ _id: orderId }, { $set });

    if (nextStatus === "ready_to_ship" && !isReturnFlow) {
      try {
        // Persist deterministic “queued” state for Ops/Seller UI
        await markShippingBookingQueued({
          Orders,
          orderId: String(orderId),
          sellerIdStr,
        });

        bookShipmentFireAndForget({
          orderId: String(orderId),
          sellerId: sellerIdStr,
          reason: "ready_to_ship",
        });
      } catch (e) {
        console.error("[shipping][fire] enqueue failed:", e?.message || e);

        // Optional: capture one failed attempt entry immediately (best-effort)
        try {
          await appendShippingBookingAttempt({
            Orders,
            orderId: String(orderId),
            sellerIdStr,
            attempt: 1,
            ok: false,
            httpStatus: null,
            code: "enqueue_failed",
            message: String(e?.message || e),
            durationMs: null,
            shipmentId: null,
            trackingNumber: null,
          });
        } catch (logErr) {
          console.error("[shipping][log] append attempt failed:", logErr?.message || logErr);
        }
      }
    }

    const updatedOrder = await Orders.findOne({ _id: orderId });
    const overall = deriveOverallStatus(updatedOrder?.sellerFulfillment || {});
    await Orders.updateOne(
      { _id: orderId },
      { $set: { status: overall, updatedAt: new Date() } }
    );

    let invoiceInfo = null;
    if (nextStatus === "shipped") {
      try {
        console.log("[orders][invoice] issuing", {
          orderId: String(orderId),
          orderNumber: updatedOrder?.orderNumber || order?.orderNumber || null,
          sellerId: sellerIdStr,
          trackingNumber:
            safeString(updatedOrder?.sellerFulfillment?.[sellerIdStr]?.shipping?.trackingNumber) ||
            safeString(order?.sellerFulfillment?.[sellerIdStr]?.shipping?.trackingNumber) ||
            null,
        });

        const out = await issueInvoiceForSellerOrder({
          sellerIdStr,
          sellerIdObj,
          order: updatedOrder || order,
        });
        if (!out?.ok) {
          console.log("[orders][invoice] failed", {
            orderId: String(orderId),
            orderNumber: updatedOrder?.orderNumber || order?.orderNumber || null,
            sellerId: sellerIdStr,
            message: out?.message || "failed",
          });
          return res.status(out?.status || 500).json({
            success: false,
            message: out?.message || "Failed to issue invoice at shipped",
          });
        }
        invoiceInfo = {
          created: !!out.created,
          invoiceId: out.invoice?._id ? String(out.invoice._id) : null,
          invoiceNumber: out.invoice?.invoiceNumber || null,
        };
        console.log("[orders][invoice] issued", {
          orderId: String(orderId),
          orderNumber: updatedOrder?.orderNumber || order?.orderNumber || null,
          sellerId: sellerIdStr,
          created: !!out.created,
          invoiceId: invoiceInfo.invoiceId,
          invoiceNumber: invoiceInfo.invoiceNumber,
        });
      } catch (e) {
        console.error("Auto-issue invoice (single) error:", e);
        return res.status(500).json({
          success: false,
          message: "Auto invoice issuance failed",
        });
      }
    }

    const final = await Orders.findOne({ _id: orderId });

    return res.json({
      success: true,
      message: `Seller status updated: ${currentSellerStatus} → ${nextStatus}`,
      sellerStatus: final?.sellerFulfillment?.[sellerIdStr]?.status || nextStatus,
      overallStatus: final?.status || overall,
      allowedNextStatuses: getAllowedNextStatuses(
        final?.sellerFulfillment?.[sellerIdStr]?.status || nextStatus
      ),
      invoice: invoiceInfo,
      order: final,
    });
  } catch (err) {
    console.error("PATCH /api/orders/:orderId/seller-status error:", err);
    return res.status(500).json({ success: false, message: "Failed to update seller status" });
  }
});

/* ===================================================
   SELLER: ISSUE INVOICE (PERSISTENT, MANUAL)
=================================================== */
router.post("/seller/:orderId/invoice/issue", authMiddleware, async (req, res) => {
  try {
    if (!ensureSeller(req, res)) return;

    const sellerIdStr = getSellerIdFromReq(req);
    const sellerIdObj = await resolveSellerObjectId(req);
    const oid = toObjectId(req.params.orderId);

    if (!sellerIdObj || !oid || !sellerIdStr) {
      return res.status(400).json({ success: false, message: "Invalid id(s)" });
    }

    const order = await Orders.findOne({
      _id: oid,
      items: { $elemMatch: { sellerId: sellerIdStr } },
    });

    if (!order) {
      return res.status(404).json({
        success: false,
        message: "Order not found for this seller",
      });
    }

    const out = await issueInvoiceForSellerOrder({ sellerIdStr, sellerIdObj, order });
    if (!out?.ok) {
      return res.status(out?.status || 500).json({
        success: false,
        message: out?.message || "Failed",
      });
    }

    return res.status(out.created ? 201 : 200).json({
      success: true,
      created: !!out.created,
      invoice: out.invoice,
    });
  } catch (err) {
    console.error("POST /api/orders/seller/:orderId/invoice/issue error:", err);
    return res.status(500).json({ success: false, message: "Failed to issue invoice" });
  }
});

/* ===================================================
   SELLER: INVOICES LIST
=================================================== */
router.get("/seller/invoices", authMiddleware, async (req, res) => {
  try {
    if (!ensureSeller(req, res)) return;

    const sellerIdStr = getSellerIdFromReq(req);
    const sellerIdObj = await resolveSellerObjectId(req);
    if (!sellerIdObj || !sellerIdStr) {
      return res.status(400).json({ success: false, message: "Invalid seller id" });
    }

    const {
      period = "last30",
      from,
      to,
      status = "",
      q = "",
      page = "1",
      pageSize,
      limit,
      includeCod,
    } = req.query;
    const sizeRaw = pageSize ?? limit ?? "10";

    const { start, end } = buildDateRange(period, from, to);

    const allowCod = String(includeCod || "").trim().toLowerCase() === "true";
    const match = {
      sellerId: sellerIdStr,
      ...(allowCod ? {} : { type: { $nin: ["cod", "cod_snapshot"] } }),
    };

    if (start || end) {
      match.invoiceDate = {};
      if (start) match.invoiceDate.$gte = start;
      if (end) match.invoiceDate.$lte = end;
    }

    const statusNorm = safeString(status).toLowerCase();
    if (statusNorm) match.status = statusNorm;

    const qNorm = safeString(q);
    if (qNorm) {
      const rx = new RegExp(escapeRegex(qNorm), "i");
      match.$or = [
        { invoiceNumber: rx },
        { orderId: rx },
        { orderNumber: rx },
        { "customer.name": rx },
        { "customer.email": rx },
        { "customer.phone": rx },
      ];
    }

    const pageNum = Math.max(1, Number(page) || 1);
    const sizeNum = Math.min(100, Math.max(1, Number(sizeRaw) || 10));
    const skip = (pageNum - 1) * sizeNum;

    const agg = await Invoices.aggregate([
      { $match: match },
      {
        $facet: {
          data: [
            { $sort: { invoiceDate: -1, createdAt: -1 } },
            { $skip: skip },
            { $limit: sizeNum },
          ],
          totalCount: [{ $count: "count" }],
          summary: [
            {
              $group: {
                _id: "$status",
                count: { $sum: 1 },
                amount: { $sum: { $ifNull: ["$totalAmount", 0] } },
              },
            },
          ],
          totalAmount: [
            {
              $group: {
                _id: null,
                amount: { $sum: { $ifNull: ["$totalAmount", 0] } },
              },
            },
          ],
        },
      },
    ]).toArray();

    const first = agg?.[0] || {};
    const invoices = first.data || [];
    const total = first.totalCount?.[0]?.count || 0;

    const byStatus = (first.summary || []).reduce((acc, row) => {
      acc[row._id || "unknown"] = row.count || 0;
      return acc;
    }, {});

    const totalAmount = first.totalAmount?.[0]?.amount || 0;

    return res.json({
      success: true,
      invoices,
      summary: {
        total,
        issued: byStatus.issued || 0,
        paid: byStatus.paid || 0,
        pending: byStatus.pending || 0,
        cancelled: byStatus.cancelled || 0,
        refunded: byStatus.refunded || 0,
        totalAmount,
      },
      pagination: {
        page: pageNum,
        pageSize: sizeNum,
        total,
        totalPages: Math.max(1, Math.ceil(total / sizeNum)),
        pages: Math.max(1, Math.ceil(total / sizeNum)),
      },
    });
  } catch (err) {
    console.error("GET /api/orders/seller/invoices error:", err);
    return res.status(500).json({ success: false, message: "Failed to load seller invoices" });
  }
});

/* ===================================================
   SELLER: INVOICE STATUS UPDATE
=================================================== */
router.patch("/seller/invoices/:invoiceId/status", authMiddleware, async (req, res) => {
  try {
    if (!ensureSeller(req, res)) return;

    const sellerIdStr = getSellerIdFromReq(req);
    const sellerIdObj = await resolveSellerObjectId(req);
    const invoiceId = toObjectId(req.params.invoiceId);
    const status = safeString(req.body?.status).toLowerCase();

    const valid = ["issued", "pending", "paid", "cancelled", "refunded"];
    if (!invoiceId || !sellerIdObj || !sellerIdStr) {
      return res.status(400).json({ success: false, message: "Invalid id(s)" });
    }
    if (!valid.includes(status)) {
      return res.status(400).json({ success: false, message: "Invalid status value" });
    }

    const oldInvoice = await Invoices.findOne({ _id: invoiceId, sellerId: sellerIdStr });

    const result = await Invoices.updateOne(
      { _id: invoiceId, sellerId: sellerIdStr },
      { $set: { status, updatedAt: new Date() } }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ success: false, message: "Invoice not found" });
    }

    const updatedInvoice = await Invoices.findOne({ _id: invoiceId });

    // Finance ledger: non-COD invoices only (COD is handled in adminOrdersRoutes on Completed)
    try {
      const prevStatus = String(oldInvoice?.status || "");
      const nextStatus = String(updatedInvoice?.status || "");
      const paymentMethod = String(
        updatedInvoice?.paymentMethod || updatedInvoice?.payment?.method || ""
      );

      const isNowPaid = nextStatus.toLowerCase() === "paid";
      const wasPaid = prevStatus.toLowerCase() === "paid";
      const isCod = paymentMethod.toLowerCase() === "cod" || !!updatedInvoice?.isCod;

      if (isNowPaid && !wasPaid && !isCod) {
        const invoiceIdStr = String(updatedInvoice?._id || "");
        const invoiceNumber = String(updatedInvoice?.invoiceNumber || updatedInvoice?.number || "");
        const sourceRef = invoiceNumber || invoiceIdStr || "INVOICE-PAID";

        const total = safeNum(
          updatedInvoice?.total ??
            updatedInvoice?.grandTotal ??
            updatedInvoice?.payableTotal ??
            updatedInvoice?.amount ??
            0
        );

        const commissionAmount = safeNum(
          updatedInvoice?.commission?.amount ??
            updatedInvoice?.commissionAmount ??
            updatedInvoice?.commission ??
            0
        );

        const sellerIdStrLeg = String(updatedInvoice?.sellerId || req.user?._id || "");
        const sellerNet = Math.max(0, total - commissionAmount);

        const legs = [];
        let allocated = 0;

        if (commissionAmount > 0) {
          legs.push({
            accountKey: "platform:commission",
            dc: "credit",
            amount: commissionAmount,
            sourceRef,
          });
          allocated += commissionAmount;
        }
        if (sellerNet > 0 && sellerIdStrLeg) {
          legs.push({
            accountKey: `seller:${sellerIdStrLeg}`,
            dc: "credit",
            amount: sellerNet,
            sourceRef,
            sellerId: sellerIdStrLeg,
          });
          allocated += sellerNet;
        }

        if (allocated > 0) {
          legs.unshift({
            accountKey: "platform:cash_bank",
            dc: "debit",
            amount: allocated,
            sourceRef,
          });

          await postTransactionGroup(await getDB(), {
            transactionGroupId: `invoice_paid_${invoiceIdStr}`,
            postedAt: new Date(),
            sourceRef,
            category: "invoice_paid_allocation",
            note: "Invoice paid allocation: cash pool -> commission + seller earnings (non-COD).",
            legs,
          });
        }
      }
    } catch (e) {
      console.error("Finance posting failed on seller invoice paid", e);
    }

    return res.json({ success: true, invoice: updatedInvoice });
  } catch (err) {
    console.error("PATCH /api/orders/seller/invoices/:invoiceId/status error:", err);
    return res.status(500).json({ success: false, message: "Failed to update invoice status" });
  }
});

/* ===================================================
   CUSTOMER / ADMIN / STAFF: ORDER INVOICE PDF
=================================================== */
router.get("/:orderId/invoice/pdf", authMiddleware, async (req, res) => {
  try {
    const oid = toObjectId(req.params.orderId);
    if (!oid) {
      return res.status(400).json({ success: false, message: "Invalid orderId" });
    }

    const isAdminOrStaff = isAdminOrStaffRole(req);
    let order = null;

    if (isAdminOrStaff) {
      order = await Orders.findOne({ _id: oid });
    } else {
      const userId = getAuthUserId(req);
      const userObjId = toObjectId(userId);
      if (!userObjId) {
        return res.status(401).json({ success: false, message: "Invalid user session" });
      }
      order = await Orders.findOne({ _id: oid, userId: userObjId });
    }

    if (!order) {
      return res.status(404).json({ success: false, message: "Order not found" });
    }

    const mode = normalizeStatus(req.query?.mode || "inline");
    const isDownload = mode === "download";

    const fileBase =
      safeString(req.query?.filename) ||
      safeString(order.orderNumber) ||
      `order-${order._id.toString().slice(-6)}`;

    const safeFile = safePdfFilename(fileBase);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `${isDownload ? "attachment" : "inline"}; filename=${safeFile}.pdf`
    );

    const doc = new PDFDocument({ margin: 40 });
    doc.pipe(res);

    const money = (n) => {
      const x = Number(n || 0);
      try {
        return x.toLocaleString("en-NP", {
          minimumFractionDigits: 0,
          maximumFractionDigits: 2,
        });
      } catch {
        return String(x);
      }
    };

    const lineY = () => {
      const y = doc.y;
      doc
        .moveTo(40, y)
        .lineTo(doc.page.width - 40, y)
        .strokeColor("#e5e7eb")
        .stroke();
      doc.moveDown(0.8);
    };

    doc.fillColor("#111827");
    doc.fontSize(18).text("Glamzi", { align: "left" });
    doc.moveDown(0.2);
    doc
      .fontSize(10)
      .fillColor("#6b7280")
      .text(isAdminOrStaff ? "Admin View (Read-only)" : "Order Invoice (Read-only)");
    doc.moveDown(0.6);
    lineY();

    const invDate = order.createdAt ? new Date(order.createdAt) : null;

    doc.fontSize(10).fillColor("#111827");
    doc.text(`Order #: ${order.orderNumber || "-"}`);
    doc.text(`Order ID: ${order._id.toString()}`);
    doc.text(`Date: ${invDate ? invDate.toLocaleDateString() : "-"}`);
    doc.text(`Status: ${(order.status || "created").toUpperCase()}`);
    const paymentMethodLabel = order.paymentMethod || order.payment?.method || "";
    const paymentStatusLabel = order.paymentStatus || order.payment?.status || "pending";

    doc.text(`Payment: ${paymentMethodLabel.toUpperCase()}`);
    doc.text(`Payment Status: ${paymentStatusLabel.toUpperCase()}`);
    doc.moveDown(0.8);

    const customerName =
      order.customerName || order.shippingAddress?.fullName || order.shippingAddress?.name || "";
    const customerPhone = order.customerPhone || order.shippingAddress?.phone || "";
    const customerEmail = order.customerEmail || "";

    doc.fontSize(12).fillColor("#111827").text("Bill To", { underline: true });
    doc.moveDown(0.3);
    doc.fontSize(10).fillColor("#374151");
    doc.text(customerName || "-");
    if (customerPhone) doc.text(customerPhone);
    if (customerEmail) doc.text(customerEmail);

    if (order.shippingAddress) {
      const sa = order.shippingAddress;
      const addrParts = [
        sa.tole || sa.addressLine1 || "",
        sa.municipalityName || sa.city || "",
        sa.district || "",
        sa.province || "",
        sa.wardNumber ? `Ward ${sa.wardNumber}` : "",
      ].filter(Boolean);

      if (addrParts.length) {
        doc.moveDown(0.2);
        doc.text(`Ship To: ${addrParts.join(", ")}`);
      }
    }

    doc.moveDown(0.8);
    lineY();

    doc.fontSize(12).fillColor("#111827").text("Items", { underline: true });
    doc.moveDown(0.6);

    const startX = 40;
    const rightX = doc.page.width - 40;

    const colNo = startX;
    const colItem = startX + 30;
    const colQty = rightX - 170;
    const colRate = rightX - 110;
    const colAmt = rightX;

    doc.fontSize(9).fillColor("#6b7280");
    doc.text("#", colNo, doc.y, { width: 25 });
    doc.text("Description", colItem, doc.y, { width: colQty - colItem - 10 });
    doc.text("Qty", colQty, doc.y, { width: 40, align: "right" });
    doc.text("Rate", colRate, doc.y, { width: 70, align: "right" });
    doc.text("Amount", colAmt - 70, doc.y, { width: 70, align: "right" });
    doc.moveDown(0.4);

    doc
      .moveTo(startX, doc.y)
      .lineTo(rightX, doc.y)
      .strokeColor("#e5e7eb")
      .stroke();
    doc.moveDown(0.5);

    doc.fontSize(10).fillColor("#111827");

    let computedSubtotal = 0;

    (order.items || []).forEach((item, idx) => {
      const qty = Math.max(1, Number(item.quantity || 1));
      const lineFinal = Number(item?.pricing?.final ?? 0);
      const unitFinal =
        qty > 0 ? lineFinal / qty : Number(item?.pricing?.final ?? item.price ?? 0);

      const amount = lineFinal || unitFinal * qty;
      computedSubtotal += amount;

      const y = doc.y;

      doc.text(String(idx + 1), colNo, y, { width: 25 });
      doc.text(String(item.title || item.name || "Item"), colItem, y, {
        width: colQty - colItem - 10,
      });
      doc.text(String(qty), colQty, y, { width: 40, align: "right" });
      doc.text(money(unitFinal), colRate, y, { width: 70, align: "right" });
      doc.text(money(amount), colAmt - 70, y, { width: 70, align: "right" });

      doc.moveDown(0.6);
    });

    doc.moveDown(0.3);
    lineY();

    const t = order.totals || {};
    const discountedSubtotal = Number(computedSubtotal || t.discountedSubtotal || t.subtotal || 0);
    const shippingFee = Number(t.shippingFee ?? 0);
    const shippingDiscount = Number(t.shippingDiscount ?? 0);
    const sellerDiscountTotal = Number(t.sellerDiscountTotal ?? 0);
    const adminDiscountTotal = Number(t.adminDiscountTotal ?? 0);
    const grandTotal = Math.max(0, discountedSubtotal + shippingFee - shippingDiscount);

    doc.fontSize(10).fillColor("#111827");
    doc.text(`Subtotal: NPR ${money(discountedSubtotal)}`, { align: "right" });

    if (sellerDiscountTotal) {
      doc.text(`Seller Discount: -NPR ${money(sellerDiscountTotal)}`, { align: "right" });
    }
    if (adminDiscountTotal) {
      doc.text(`Admin Discount: -NPR ${money(adminDiscountTotal)}`, { align: "right" });
    }

    if (shippingFee) doc.text(`Shipping: NPR ${money(shippingFee)}`, { align: "right" });
    if (shippingDiscount) {
      doc.text(`Shipping Discount: -NPR ${money(shippingDiscount)}`, { align: "right" });
    }

    doc.moveDown(0.2);
    doc.fontSize(12).text(`Total: NPR ${money(grandTotal)}`, { align: "right" });

    doc.moveDown(1);
    doc
      .fontSize(9)
      .fillColor("#6b7280")
      .text("This invoice is generated from the order snapshot and is read-only.", {
        align: "left",
      });

    doc.end();
  } catch (err) {
    console.error("Customer/Admin invoice PDF error:", err);
    return res.status(500).json({ success: false, message: "Failed to generate invoice PDF" });
  }
});

/* ===================================================
   CUSTOMER: SINGLE ORDER / CANCEL / INVOICE JSON
=================================================== */
router.get("/:orderId", authMiddleware, async (req, res) => {
  try {
    const userId = getAuthUserId(req);
    const userObjId = toObjectId(userId);
    const oid = toObjectId(req.params.orderId);

    if (!oid) return res.status(400).json({ success: false, message: "Invalid orderId" });
    if (!userObjId) return res.status(401).json({ success: false, message: "Invalid user session" });

    const order = await Orders.findOne({ _id: oid, userId: userObjId });
    if (!order) return res.status(404).json({ success: false, message: "Order not found" });

    return res.json({ success: true, order });
  } catch (err) {
    console.error("GET /api/orders/:orderId error:", err);
    return res.status(500).json({ success: false, message: "Failed to load order" });
  }
});

router.post(
  "/:orderId/return-request",
  authMiddleware,
  uploadReturn.fields([{ name: "attachments", maxCount: 5 }]),
  async (req, res) => {
    try {
      if (!ensureCustomer(req, res)) return;

      const userId = getAuthUserId(req);
      const userObjId = toObjectId(userId);
      const oid = toObjectId(req.params.orderId);

      if (!oid) return res.status(400).json({ success: false, message: "Invalid orderId" });
      if (!userObjId) return res.status(401).json({ success: false, message: "Invalid user session" });

      const order = await Orders.findOne({ _id: oid, userId: userObjId });
      if (!order) return res.status(404).json({ success: false, message: "Order not found" });

      if (order.returnRequest && order.returnRequest.status !== "cancelled") {
        return res.json({
          success: true,
          message: "Return request already submitted",
          returnRequest: order.returnRequest,
          order,
        });
      }

      const reason = safeString(req.body?.reason);
      const notes = safeString(req.body?.notes);

      if (!reason) {
        return res.status(400).json({ success: false, message: "Return reason is required" });
      }

      const attachments =
        (req.files?.attachments || []).map((f) => ({
          originalName: f.originalname,
          mimeType: f.mimetype,
          size: f.size,
        })) || [];

      const now = new Date();
      const historyEntry = { status: "submitted", at: now };
      if (notes) historyEntry.note = notes;

      const returnRequest = {
        status: "submitted",
        reason,
        notes,
        attachments,
        history: [historyEntry],
        submittedAt: now,
        updatedAt: now,
      };

      const statusNormalized = normalizeStatus(order.status);
      const statusSet =
        statusNormalized === "return_requested"
          ? {}
          : { status: "return_requested", returnRequestedAt: now };

      await Orders.updateOne(
        { _id: oid },
        {
          $set: {
            returnRequest,
            updatedAt: now,
            ...statusSet,
          },
        }
      );

      const updated = await Orders.findOne({ _id: oid });
      return res.status(201).json({
        success: true,
        message: "Return request submitted",
        returnRequest: updated?.returnRequest || returnRequest,
        order: updated,
      });
    } catch (err) {
      console.error("POST /api/orders/:orderId/return-request error:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to submit return request",
      });
    }
  }
);

router.patch("/:orderId/cancel", authMiddleware, async (req, res) => {
  try {
    const userId = getAuthUserId(req);
    const userObjId = toObjectId(userId);
    const oid = toObjectId(req.params.orderId);

    if (!oid) return res.status(400).json({ success: false, message: "Invalid orderId" });
    if (!userObjId) return res.status(401).json({ success: false, message: "Invalid user session" });

    const order = await Orders.findOne({ _id: oid, userId: userObjId });
    if (!order) return res.status(404).json({ success: false, message: "Order not found" });

    if (normalizeStatus(order.status) === "cancelled") {
      return res.json({ success: true, message: "Order already cancelled", order });
    }

    const now = new Date();
    await Orders.updateOne(
      { _id: oid },
      {
        $set: {
          status: "cancelled",
          updatedAt: now,
          cancelledAt: now,
          cancelledBy: "customer",
        },
      }
    );

    const updated = await Orders.findOne({ _id: oid });
    return res.json({ success: true, message: "Order cancelled", order: updated });
  } catch (err) {
    console.error("PATCH /api/orders/:orderId/cancel error:", err);
    return res.status(500).json({ success: false, message: "Failed to cancel order" });
  }
});

router.get("/:orderId/invoice", authMiddleware, async (req, res) => {
  try {
    const userId = getAuthUserId(req);
    const userObjId = toObjectId(userId);
    const oid = toObjectId(req.params.orderId);

    if (!oid) return res.status(400).json({ success: false, message: "Invalid orderId" });
    if (!userObjId) return res.status(401).json({ success: false, message: "Invalid user session" });

    const order = await Orders.findOne({ _id: oid, userId: userObjId });
    if (!order) return res.status(404).json({ success: false, message: "Order not found" });

    res.setHeader("Content-Type", "application/json");
    return res.send({
      invoiceNumber: order._id.toString(),
      date: order.createdAt,
      customerId: order.userId,
      items: order.items,
      totals: order.totals,
      paymentMethod: order.paymentMethod,
      paymentStatus: order.paymentStatus || "pending",
      status: order.status,
      shippingAddress: order.shippingAddress,
    });
  } catch (err) {
    console.error("GET /api/orders/:orderId/invoice error:", err);
    return res.status(500).json({ success: false, message: "Failed to generate invoice" });
  }
});

/* ===================================================
   SELLER: RETURNS LIST + DECISION
   Update: seller decision now also writes a lightweight sellerDecision object
           and keeps order.status = "return_requested" when approved.
=================================================== */
router.get("/seller/returns", authMiddleware, async (req, res) => {
  try {
    if (!ensureSeller(req, res)) return;
    const sellerIdStr = getSellerIdFromReq(req);
    if (!sellerIdStr) {
      return res.status(401).json({ success: false, message: "Invalid seller session" });
    }

    const returns = await Orders.aggregate([
      {
        $match: {
          returnRequest: { $exists: true },
          "items.sellerId": sellerIdStr,
        },
      },
      {
        $project: {
          orderNumber: "$orderNumber",
          orderId: "$_id",
          customerName: {
            $ifNull: ["$customerName", { $ifNull: ["$customer.name", "$shippingAddress.name"] }],
          },
          customerPhone: {
            $ifNull: ["$customerPhone", { $ifNull: ["$customer.phone", "$shippingAddress.phone"] }],
          },
          status: "$returnRequest.status",
          reason: "$returnRequest.reason",
          notes: "$returnRequest.notes",
          createdAt: "$returnRequest.submittedAt",
          attachments: "$returnRequest.attachments",
          totals: "$totals",
          returnAdmin: "$returnAdmin",
        },
      },
    ]).toArray();

    return res.json({
      success: true,
      returns: returns.map((r) => {
        const adminData = r.returnAdmin || null;
        const history = r.history || [];
        const status = normalizeReturnStatus(r.status || RETURN_STATUS.PENDING);
        const returnAdminPickup = adminData?.pickup || null;
        const orderIdStr = r?.orderId ? String(r.orderId) : "";
        return {
          orderId: orderIdStr,
          orderNumber: r.orderNumber || orderIdStr,
          customerName: r.customerName || "",
          customerPhone: r.customerPhone || "",
          status,
          reason: r.reason || "",
          notes: r.notes || "",
          createdAt: r.createdAt || null,
          updatedAt: r.updatedAt || null,
          history,
          attachments: r.attachments || [],
          amount: r.totals?.grandTotal ?? r.totals?.net ?? r.totals?.gross ?? 0,
          returnAdmin: adminData
            ? {
                ...adminData,
                pickup: returnAdminPickup,
              }
            : null,
          returnAdminPickup,
        };
      }),
    });
  } catch (err) {
    console.error("GET /api/orders/seller/returns error:", err);
    return res.status(500).json({ success: false, message: "Failed to load returns" });
  }
});

router.patch("/seller/returns/:orderId/decision", authMiddleware, async (req, res) => {
  try {
    if (!ensureSeller(req, res)) return;
    const sellerIdStr = getSellerIdFromReq(req);
    const orderIdentifier = req.params.orderId;
    let orderId = toObjectId(orderIdentifier);
    const decision = String(req.body?.decision || "").toLowerCase();

    if (!orderId) {
      const orderByNumber = await Orders.findOne({ orderNumber: orderIdentifier });
      if (orderByNumber) {
        orderId = orderByNumber._id;
      } else {
        return res.status(400).json({ success: false, message: "Invalid orderId" });
      }
    }
    if (!["approved", "rejected"].includes(decision)) {
      return res.status(400).json({
        success: false,
        message: "decision must be approved or rejected",
      });
    }

    const order = await Orders.findOne({
      _id: orderId,
      returnRequest: { $exists: true },
    });

    if (!order) {
      return res.status(404).json({ success: false, message: "Return not found" });
    }

    if (decision === "approved") {
      const now = new Date();
      const nextStatus = "approved_awaiting_pickup";
      const note = safeString(req.body?.note || "");
      const historyEntry = {
        status: nextStatus,
        at: now,
        actor: getActorId(req),
        ...(note ? { note } : {}),
      };

      await Orders.updateOne(
        { _id: orderId },
        {
          $set: {
            "returnRequest.status": nextStatus,
            "returnRequest.decidedAt": now,
            "returnRequest.updatedAt": now,
            "returnRequest.sellerDecision": {
              decision: "approved",
              sellerId: sellerIdStr || null,
              decidedAt: now,
              note: note || null,
            },
            updatedAt: now,
          },
          $push: { "returnRequest.history": historyEntry },
        }
      );

      const updated = await Orders.findOne({ _id: orderId });
      return res.json({
        success: true,
        message: "Return approved (awaiting pickup)",
        returnRequest: updated?.returnRequest || null,
        order: updated,
      });
    }

    const now = new Date();
    const nextStatus = "rejected";
    const historyEntry = { status: nextStatus, at: now };

    const update = {
      $set: {
        "returnRequest.status": nextStatus,
        "returnRequest.decidedAt": now,
        "returnRequest.updatedAt": now,
        updatedAt: now,
      },
      $push: { "returnRequest.history": historyEntry },
    };

    await Orders.updateOne({ _id: orderId }, update);
    const updated = await Orders.findOne({ _id: orderId });

    return res.json({
      success: true,
      message: "Return rejected",
      returnRequest: updated?.returnRequest || null,
      order: updated,
    });
  } catch (err) {
    console.error("PATCH /api/orders/seller/returns/:orderId/decision error:", err);
    return res
      .status(500)
      .json({ success: false, message: "Failed to update return decision" });
  }
});

router.patch("/seller/returns/:orderId/received", authMiddleware, async (req, res) => {
  try {
    if (!ensureSeller(req, res)) return;

    const orderId = toObjectId(req.params.orderId);
    if (!orderId) {
      return res.status(400).json({ success: false, message: "Invalid orderId" });
    }

    const order = await Orders.findOne({ _id: orderId, returnRequest: { $exists: true } });
    if (!order) {
      return res.status(404).json({ success: false, message: "Return not found" });
    }

    const currentStatus = normalizeReturnStatus(
      order.returnRequest?.status || RETURN_STATUS.PENDING
    );
    const nextStatus = RETURN_STATUS.RECEIVED_BY_SELLER;

    if (!canTransitionReturnStatus(currentStatus, nextStatus, "seller")) {
      return res.status(409).json({
        success: false,
        message: `Cannot mark return from ${currentStatus} to ${nextStatus} as seller`,
      });
    }

    const now = new Date();
    const note = safeString(req.body?.note || "");
    const historyEntry = {
      status: nextStatus,
      at: now,
      actor: getActorId(req),
      ...(note ? { note } : {}),
    };

    await Orders.updateOne(
      { _id: orderId },
      {
        $set: {
          "returnRequest.status": nextStatus,
          "returnRequest.updatedAt": now,
          "returnRequest.sellerReceivedAt": now,
        },
        $push: { "returnRequest.history": historyEntry },
      }
    );

    const updated = await Orders.findOne({ _id: orderId });
    return res.json({
      success: true,
      message: "Return marked as received by seller",
      returnRequest: updated?.returnRequest || null,
      order: updated,
    });
  } catch (err) {
    console.error("PATCH /api/orders/seller/returns/:orderId/received error:", err);
    return res
      .status(500)
      .json({ success: false, message: "Failed to mark return received" });
  }
});

export default router;
