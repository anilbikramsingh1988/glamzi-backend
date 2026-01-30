import express from "express";
import { ObjectId } from "mongodb";
import axios from "axios";

import { client } from "../dbConfig.js";
import { authMiddleware } from "../middlewares/authMiddleware.js";
import { isStaffMiddleware, ensureAdminRole } from "../middlewares/staffGuard.js";
import { safeInt, escapeRegex } from "../utils/query.js";

import {
  RETURN_STATUS,
  normalizeReturnStatus,
  canTransitionReturnStatus,
} from "../utils/returnsStatus.js";
import { casReturnStatus } from "./_returnHelpers.js";

import { logShippingBookingFailure } from "../utils/shippingLog.js";
import { notifyCustomer, notifySeller } from "../utils/notify.js";

const router = express.Router();
const db = client.db(process.env.DB_NAME || "glamzi_ecommerce");

const Returns = db.collection("returns");
const ReturnShipments = db.collection("returnShipments");
const Refunds = db.collection("refunds");
const LedgerEntries = db.collection("ledgerEntries");
const Orders = db.collection("orders");
const Invoices = db.collection("invoices");
const Users = db.collection("users");
const DriverJobs = db.collection("driverJobs");

/* ----------------------------- small helpers ----------------------------- */

function toObjectId(id) {
  try {
    if (!id) return null;
    if (id instanceof ObjectId || id?._bsontype === "ObjectId") return id;
    return new ObjectId(String(id));
  } catch {
    return null;
  }
}

function now() {
  return new Date();
}

function safeStr(v) {
  if (v == null) return null;
  const s = typeof v === "string" ? v.trim() : String(v).trim();
  return s || null;
}

function money(n) {
  const x = Number(n);
  return Number.isFinite(x) ? x : 0;
}

// IMPORTANT: treat 0/0 as "missing" and only allow finite non-zero
function normalizeGeo(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return null;
  if (x === 0) return null;
  return x;
}

function event(actor, type, meta = {}) {
  return { at: now(), actor, type, meta };
}

// Finance role is not part of returnsStatus roleOf() (customer|seller|admin|system)
// So we map finance actions to "admin" for transition checks.
function actorRoleForTransitions(req, fallback = "admin") {
  const r = String(req.user?.role || fallback).toLowerCase();
  if (["customer", "seller", "admin", "system"].includes(r)) return r;
  return "admin";
}

/* ----------------------------- driver job peek helpers ----------------------------- */

async function fetchLatestDriverJobInfo(returnId) {
  if (!returnId) return null;
  const rid = toObjectId(returnId);
  if (!rid) return null;

  const job = await DriverJobs.find({ returnId: rid })
    .sort({ updatedAt: -1, createdAt: -1 })
    .limit(1)
    .next();

  if (!job) return null;

  const updatedAt = job.updatedAt || job.modifiedAt || job.createdAt || null;

  return {
    jobId: job._id,
    status: String(job.status || job.scope?.status || "").trim() || null,
    driverId: job.driverId || null,
    driverName: job.driverName || job.driver?.name || null,
    scope: job.scope || null,
    scopeKey: job.scopeKey || null,
    returnFlow: job.returnFlow || job.flow === "return" || null,
    updatedAt,
    events: job.events || [],
    history: job.history || [],
  };
}

/* ----------------------------- refund math ----------------------------- */

function computeRefundAmounts(ret) {
  const requestItems = Array.isArray(ret?.request?.items) ? ret.request.items : [];
  const legacyItems = Array.isArray(ret?.items) ? ret.items : [];
  const snapshotItems = requestItems.length ? requestItems : legacyItems;

  let itemsSubtotal = 0;
  let shippingRefund = 0;
  let taxRefund = 0;
  let discountReversal = 0;

  if (requestItems.length) {
    for (const it of snapshotItems) {
      const pricing = it?.pricing || {};
      itemsSubtotal += money(
        pricing.lineSubtotalPaid ??
          pricing.subtotal ??
          pricing.lineSubtotal ??
          pricing.amount ??
          0
      );
      shippingRefund += money(
        pricing.shippingPaidAllocation ??
          pricing.shippingPaid ??
          pricing.shippingRefund ??
          0
      );
      taxRefund += money(pricing.taxPaid ?? pricing.tax ?? 0);
    }
  } else {
    for (const it of snapshotItems) {
      const qty = money(it.qtyApproved ?? it.qtyRequested ?? it.qty ?? 0);
      const unit = money(it.unitPrice ?? it.price ?? it.pricing?.unitPrice ?? 0);
      if (qty > 0 && unit >= 0) itemsSubtotal += qty * unit;
    }
  }

  const total = itemsSubtotal + shippingRefund + taxRefund - discountReversal;

  const paymentMethodRaw = String(
    ret?.paymentMethod || ret?.payment?.method || ret?.request?.paymentMethod || "cod"
  )
    .trim()
    .toLowerCase();

  const paymentMethod =
    paymentMethodRaw === "prepaid" || paymentMethodRaw === "online" ? "prepaid" : "cod";

  const strategy = paymentMethod === "prepaid" ? "card_refund" : "cod_settlement_adjustment";

  return {
    currency: String(ret?.currency || "NPR"),
    itemsSubtotal,
    shippingRefund,
    taxRefund,
    discountReversal,
    total,
    paymentMethod,
    strategy,
    status: "not_started",
  };
}

async function computeCommissionReversalFromInvoice({
  orderId,
  sellerId,
  refundedBaseAmount,
  session,
}) {
  if (!orderId || !sellerId) {
    return {
      amount: 0,
      snapshotUsed: {
        rateType: "percentage",
        rate: 0,
        baseAmount: refundedBaseAmount,
        amount: 0,
        note: "missing order/seller context",
      },
    };
  }

  const inv = await Invoices.findOne(
    { orderId, sellerId: String(sellerId) },
    { session, sort: { createdAt: -1 } }
  );

  const snap = inv?.commissionSnapshot || inv?.commission || null;
  const base = Number(refundedBaseAmount || 0);

  if (!snap) {
    return {
      amount: 0,
      snapshotUsed: {
        rateType: "percentage",
        rate: 0,
        baseAmount: base,
        amount: 0,
        note: "missing snapshot",
      },
    };
  }

  const rateType = String(snap.rateType || snap.type || "percentage").toLowerCase();
  const rate = Number(snap.rate || snap.ratePct || 0);

  let amount = 0;

  if (rateType === "percentage") {
    amount = Math.round((base * rate) / 100);
  } else if (rateType === "flat") {
    const invBase = Number(
      snap.baseAmount || inv?.subtotal || inv?.amounts?.subtotal || inv?.amount || 0
    );
    const ratio = invBase > 0 ? Math.min(1, base / invBase) : 0;
    amount = Math.round(Number(snap.amount || rate) * ratio);
  }

  return {
    amount: Math.max(0, amount),
    snapshotUsed: {
      rateType,
      rate,
      baseAmount: base,
      amount: Math.max(0, amount),
      fromInvoiceId: inv?._id ? String(inv._id) : null,
    },
  };
}

async function createLedgerEntriesForRefund({ ret, refundDoc, paymentContext = {}, session }) {
  const LedgerEntriesColl = db.collection("ledgerEntries");
  const currency = refundDoc.currency;
  const total = money(refundDoc.amounts?.total);
  const nowAt = now();

  const commissionResult = await computeCommissionReversalFromInvoice({
    orderId: ret.orderId,
    sellerId: ret.sellerId,
    refundedBaseAmount: refundDoc.amounts?.itemsSubtotal ?? total,
    session,
  });

  const refundEntry = {
    type: "REFUND",
    source: { kind: "return", id: ret._id },
    orderId: ret.orderId,
    orderNumber: ret.orderNumber,
    sellerId: ret.sellerId,
    customerId: ret.customerId,
    currency,
    debit: total,
    credit: 0,
    meta: {
      refundId: refundDoc._id,
      note: "Return refund issued",
      paymentContext: paymentContext || null,
    },
    sellerImpact: -total,
    status: "posted",
    createdAt: nowAt,
  };

  const commissionEntry = {
    type: "COMMISSION_REVERSAL",
    source: { kind: "return", id: ret._id },
    orderId: ret.orderId,
    orderNumber: ret.orderNumber,
    sellerId: ret.sellerId,
    customerId: ret.customerId,
    currency,
    debit: 0,
    credit: commissionResult.amount,
    meta: {
      refundId: refundDoc._id,
      commissionSnapshot: commissionResult.snapshotUsed,
      note: "Commission reversal for returned items (invoice snapshot)",
    },
    sellerImpact: commissionResult.amount,
    status: "posted",
    createdAt: nowAt,
  };

  const entries = [refundEntry, commissionEntry];

  const paymentMethod = String(paymentContext.paymentMethod || "").toLowerCase();
  const codSettlementStatus = String(paymentContext.codSettlementStatus || "").toLowerCase();

  if (paymentMethod === "cod") {
    const adjustmentType =
      codSettlementStatus === "settled" ? "SELLER_PAYOUT_ADJUSTMENT" : "COD_ADJUSTMENT";

    entries.push({
      type: adjustmentType,
      source: { kind: "return", id: ret._id },
      orderId: ret.orderId,
      orderNumber: ret.orderNumber,
      sellerId: ret.sellerId,
      customerId: ret.customerId,
      currency,
      debit: 0,
      credit: total,
      meta: {
        refundId: refundDoc._id,
        codSettlementStatus,
        codBatchId: paymentContext.codBatchId || null,
      },
      sellerImpact: -total,
      status: "posted",
      createdAt: nowAt,
    });
  } else if (String(refundDoc.method || "").toLowerCase() === "wallet_credit") {
    entries.push({
      type: "WALLET_CREDIT",
      source: { kind: "return", id: ret._id },
      orderId: ret.orderId,
      orderNumber: ret.orderNumber,
      sellerId: ret.sellerId,
      customerId: ret.customerId,
      currency,
      debit: 0,
      credit: total,
      meta: {
        refundId: refundDoc._id,
        note: "Wallet credit issued for return",
        paymentContext: paymentContext || null,
      },
      sellerImpact: 0,
      status: "posted",
      createdAt: nowAt,
    });
  }

  const insertRes = await LedgerEntriesColl.insertMany(entries, { session });
  const ids = insertRes.insertedIds ? Object.values(insertRes.insertedIds) : [];
  return ids;
}

/* ----------------------------- shipping config ----------------------------- */

const SHIPPING_SERVICE_URL = (process.env.SHIPPING_SERVICE_URL || "").trim();
const SHIPPING_INTERNAL_TOKEN = (process.env.SHIPPING_INTERNAL_TOKEN || "").trim();

function assertShippingConfigured() {
  if (!SHIPPING_SERVICE_URL) throw new Error("SHIPPING_SERVICE_URL not set");
}

function safeAddrField(src, fields) {
  if (!src) return null;
  for (const f of fields) if (src[f]) return src[f];
  return null;
}

function buildAddress(src, fallbackName) {
  if (!src) return null;

  const addressLine1 =
    safeAddrField(src, ["addressLine1", "addressLine", "address", "line1"]) || null;
  const addressLine2 = safeAddrField(src, ["addressLine2", "address2", "line2"]) || null;

  const addressParts = [addressLine1, addressLine2].filter(Boolean);
  const address = addressParts.length ? addressParts.join(", ") : null;

  return {
    name: String(src.name || fallbackName || "").trim() || fallbackName || null,
    phone: String(src.phone || src.mobile || "").trim() || null,
    address,
    addressLine1,
    addressLine2,
    city: String(src.city || src.municipality || "").trim() || null,
    district: String(src.district || "").trim() || null,
    province: String(src.province || "").trim() || null,
    ward: String(src.ward || "").trim() || null,
    postalCode: String(src.postalCode || src.postal || "").trim() || null,
    lat: normalizeGeo(src.lat ?? src.latitude ?? src.geo?.lat ?? null),
    lng: normalizeGeo(src.lng ?? src.longitude ?? src.geo?.lng ?? null),
  };
}

function buildSellerSnapshot(sellerDoc = {}) {
  if (!sellerDoc) return null;

  const phone =
    String(
      sellerDoc.supportPhone ||
        sellerDoc.ownerPhone ||
        sellerDoc.balancePhone ||
        sellerDoc.phone ||
        ""
    ).trim() || null;

  const street =
    safeAddrField(sellerDoc, ["streetAddress", "addressLine1", "address", "tole"]) || null;

  return {
    name: sellerDoc.storeName || sellerDoc.name || "Seller",
    phone,
    addressLine1: street,
    city: String(sellerDoc.municipalityName || sellerDoc.municipality || "").trim() || null,
    district: String(sellerDoc.district || "").trim() || null,
    province: String(sellerDoc.province || "").trim() || null,
    ward: sellerDoc.wardNumber || sellerDoc.ward || null,
    postalCode:
      String(sellerDoc.postalCode || sellerDoc.postal || sellerDoc.zip || "").trim() || null,
    // IMPORTANT: canonical seller geo = Users.location.lat/lng; treat 0/0 as missing
    lat: normalizeGeo(sellerDoc.location?.lat ?? sellerDoc.lat ?? null),
    lng: normalizeGeo(sellerDoc.location?.lng ?? sellerDoc.lng ?? null),
  };
}

async function enrichReturnWithAddress(ret) {
  if (!ret) return ret;

  const orderId = toObjectId(ret.orderId);
  const orderDoc =
    orderId &&
    (await Orders.findOne(
      { _id: orderId },
      {
        projection: {
          shippingAddress: 1,
          shippingAddressSnapshot: 1,
          shippingAddressLegacy: 1,
        },
      }
    ));

  const sellerId = toObjectId(ret.sellerId);
  const sellerDoc =
    sellerId &&
    (await Users.findOne(
      { _id: sellerId },
      {
        projection: {
          storeName: 1,
          name: 1,
          phone: 1,
          supportPhone: 1,
          ownerPhone: 1,
          streetAddress: 1,
          tole: 1,
          municipalityName: 1,
          municipality: 1,
          district: 1,
          province: 1,
          wardNumber: 1,
          ward: 1,
          postalCode: 1,
          location: 1,
        },
      }
    ));

  const pickupAddressSnapshot =
    ret.request?.pickupAddressSnapshot ||
    orderDoc?.shippingAddress ||
    orderDoc?.shippingAddressSnapshot ||
    orderDoc?.shippingAddressLegacy ||
    null;

  const sellerSnapshot =
    sellerDoc &&
    buildSellerSnapshot({
      ...sellerDoc,
      municipality: sellerDoc?.municipality || sellerDoc?.municipalityName,
    });

  return {
    ...ret,
    request: {
      ...(ret.request || {}),
      pickupAddressSnapshot: ret.request?.pickupAddressSnapshot || pickupAddressSnapshot || null,
    },
    sellerPickupAddressSnapshot: ret.sellerPickupAddressSnapshot || sellerSnapshot || null,
  };
}

async function enrichReturnWithCustomer(ret) {
  if (!ret) return ret;

  const enriched = { ...ret };

  let orderDoc = null;
  if (ret.orderId) {
    const orderId = toObjectId(ret.orderId);
    if (orderId) {
      orderDoc = await Orders.findOne(
        { _id: orderId },
        { projection: { userId: 1, shippingAddress: 1, shippingAddressSnapshot: 1 } }
      );
    }
  }

  const userIdValue =
    orderDoc?.userId ||
    ret.customerId ||
    ret.customer?._id ||
    ret.request?.customerId ||
    ret.request?.customer?._id;

  const userId = toObjectId(userIdValue);

  let customer = null;
  if (userId) {
    customer = await Users.findOne(
      { _id: userId },
      { projection: { name: 1, fullName: 1, firstName: 1, lastName: 1, phone: 1 } }
    );
  }

  const name =
    customer?.fullName ||
    customer?.name ||
    [customer?.firstName, customer?.lastName].filter(Boolean).join(" ").trim() ||
    ret.customer?.name ||
    ret.request?.customerName ||
    "";

  const phone =
    customer?.phone ||
    ret.customer?.phone ||
    ret.request?.customerPhone ||
    orderDoc?.shippingAddress?.phone ||
    orderDoc?.shippingAddressSnapshot?.phone ||
    "";

  enriched.customerName = name || null;
  enriched.customerPhone = phone || null;

  const driverJob = await fetchLatestDriverJobInfo(ret._id);
  if (driverJob) enriched.driverJob = driverJob;

  return enriched;
}

function buildReturnPickupPayload(ret, { attempt = 1, idempotencyKey = null } = {}) {
  const customerAddress = buildAddress(
    ret.request?.pickupAddressSnapshot,
    ret.request?.customerName || "Customer"
  );

  const sellerAddress = buildAddress(ret.sellerPickupAddressSnapshot, ret.sellerName || "Seller");

  const reasonCode = String(ret.items?.[0]?.reasonCode || "other");
  const returnWindowDays = Number(
    ret.items?.[0]?.returnWindowDays || process.env.RETURN_WINDOW_DAYS || 7
  );
  const fragile = Boolean(ret.request?.flags?.fragile || ret.request?.fragile);

  // ✅ Booking-time zone resolver hints (shipping service uses these when meta.zoneResolve=true)
  const zoneHints = {
    wardNumber: customerAddress?.ward || null,
    postalCode: customerAddress?.postalCode || null,
    locality: customerAddress?.city || null,
    city: customerAddress?.city || null,
    district: customerAddress?.district || null,
    province: customerAddress?.province || null,
  };

  return {
    orderId: ret.orderId || null,
    sellerId: ret.sellerId || null,
    partner: "everestx",
    returnFlow: true,
    direction: "CUSTOMER_TO_SELLER",
    reference: {
      returnId: String(ret._id),
      returnNumber: ret.returnNumber,
      orderId: ret.orderId || null,
      orderNumber: ret.orderNumber || null,
      sellerId: ret.sellerId,
      customerId: ret.customerId || null,
      bookingAttempt: Number(attempt || 1),
      idempotencyKey: idempotencyKey || null,
    },
    from: customerAddress,
    to: sellerAddress,
    parcels: [
      {
        count: 1,
        weightKg: Number(ret.pickup?.weightKg || 0) || undefined,
        notes: ret.pickup?.notes || "Return parcels",
      },
    ],
    cod: { isCod: false },
    meta: {
      reasonCode,
      returnPolicyWindowDays: returnWindowDays,
      fragile,
      // ✅ signal resolver in shipping backend
      zoneResolve: true,
      zoneHints,
      routeHints: ret.routing
        ? { hubCode: ret.routing.hubCode || null, zoneCode: ret.routing.zoneCode || null }
        : null,
    },
  };
}

async function dispatchReturnDriverJob({
  driverId,
  shipmentId,
  trackingNumber,
  partner = "everestx",
  orderId,
  orderNumber,
  returnId,
  actor,
  note,
  code,
  source,
}) {
  if (!driverId) return;
  if (!SHIPPING_SERVICE_URL) return;

  const target = `${SHIPPING_SERVICE_URL.replace(/\/+$/, "")}/api/internal/dispatch/assign`;
  const payload = {
    driverId,
    ...(shipmentId ? { shipmentId: String(shipmentId) } : {}),
    ...(trackingNumber ? { trackingNumber } : {}),
    partner,
    orderId: orderId || null,
    orderNumber: orderNumber || null,
    note: note || `Return pickup${returnId ? ` ${returnId}` : ""}`,
    actor: actor || { role: "admin", id: "system" },
    code: code || "RETURN_PICKUP_ASSIGN",
    source: source || "returns_pickup",
  };

  const headers = {
    "Content-Type": "application/json",
    ...(SHIPPING_INTERNAL_TOKEN ? { "x-internal-token": SHIPPING_INTERNAL_TOKEN } : {}),
  };

  await axios.post(target, payload, { headers, timeout: 15000 });
}

/* ----------------------------- list + detail ----------------------------- */

router.get(
  "/",
  authMiddleware,
  isStaffMiddleware,
  ensureAdminRole("orders"),
  async (req, res) => {
    const page = safeInt(req.query.page, 1, 1, 100000);
    const limit = safeInt(req.query.limit, 20, 1, 100);
    const skip = (page - 1) * limit;

    const q = String(req.query.q || "").trim();

    // IMPORTANT: return statuses should be normalized via returnsStatus utils
    const status = normalizeReturnStatus(req.query.status || "");
    const sellerId = String(req.query.sellerId || "").trim();

    const from = req.query.from ? new Date(req.query.from) : null;
    const to = req.query.to ? new Date(req.query.to) : null;

    const match = {};
    if (status) match.status = status;
    if (sellerId) match.sellerId = sellerId;

    if ((from && !Number.isNaN(from.getTime())) || (to && !Number.isNaN(to.getTime()))) {
      match.createdAt = {};
      if (from && !Number.isNaN(from.getTime())) match.createdAt.$gte = from;
      if (to && !Number.isNaN(to.getTime())) match.createdAt.$lte = to;
      if (Object.keys(match.createdAt).length === 0) delete match.createdAt;
    }

    if (q) {
      const rx = new RegExp(escapeRegex(q), "i");
      match.$or = [{ returnNumber: rx }, { orderNumber: rx }, { "request.notes": rx }];
    }

    const pipeline = [
      { $match: match },
      { $sort: { createdAt: -1 } },
      {
        $facet: {
          rows: [{ $skip: skip }, { $limit: limit }],
          total: [{ $count: "count" }],
        },
      },
    ];

    const out = await Returns.aggregate(pipeline).toArray();
    const rawRows = out?.[0]?.rows || [];

    const rows = await Promise.all(
      rawRows.map(async (row) => {
        const withAddr = await enrichReturnWithAddress(row);
        return enrichReturnWithCustomer(withAddr);
      })
    );

    const total = out?.[0]?.total?.[0]?.count || 0;

    return res.json({ page, limit, total, rows });
  }
);

// Refund queue (finance) - fetch returns in refund_queued
router.get(
  "/refunds/queue",
  authMiddleware,
  isStaffMiddleware,
  ensureAdminRole("finance"),
  async (req, res) => {
    const limit = safeInt(req.query.limit, 50, 1, 200);
    try {
      const rows = await Returns.aggregate([
        { $match: { status: "refund_queued" } },
        { $sort: { updatedAt: -1 } },
        { $limit: limit },
        // normalize order id so we can join even if stored as string
        {
          $addFields: {
            orderIdObj: {
              $convert: { input: "$orderId", to: "objectId", onError: null, onNull: null },
            },
          },
        },
        {
          $lookup: {
            from: "orders",
            let: { oid: "$orderIdObj", orderNumber: "$orderNumber" },
            pipeline: [
              {
                $match: {
                  $expr: {
                    $or: [
                      { $eq: ["$_id", "$$oid"] },
                      { $and: [{ $ne: ["$$orderNumber", null] }, { $eq: ["$orderNumber", "$$orderNumber"] }] },
                    ],
                  },
                },
              },
              {
                $project: {
                  customerName: 1,
                  customerPhone: 1,
                  customer: 1,
                  shipping: 1,
                },
              },
            ],
            as: "orderDoc",
          },
        },
        { $unwind: { path: "$orderDoc", preserveNullAndEmptyArrays: true } },
        {
          $project: {
            returnNumber: 1,
            orderNumber: 1,
            refund: 1,
            status: 1,
            updatedAt: 1,
            customerName: {
              $ifNull: [
                "$customerName",
                {
                  $ifNull: [
                    "$request.customerName",
                    {
                      $ifNull: [
                        "$customer.name",
                        {
                          $ifNull: [
                            "$orderDoc.customerName",
                            {
                              $ifNull: [
                                "$orderDoc.customer.name",
                                { $ifNull: ["$orderDoc.customer.fullName", "$orderDoc.shipping.name"] },
                              ],
                            },
                          ],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
            customerPhone: {
              $ifNull: [
                "$customerPhone",
                {
                  $ifNull: [
                    "$request.customerPhone",
                    {
                      $ifNull: [
                        "$customer.phone",
                        {
                          $ifNull: [
                            "$orderDoc.customerPhone",
                            { $ifNull: ["$orderDoc.customer.phone", "$orderDoc.shipping.phone"] },
                          ],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          },
        },
      ]).toArray();

      return res.json({ returns: rows });
    } catch (err) {
      console.error("GET refund queue error", err);
      return res.status(500).json({ message: "Server error" });
    }
  }
);

router.get(
  "/:id",
  authMiddleware,
  isStaffMiddleware,
  ensureAdminRole("orders"),
  async (req, res) => {
    const rid = toObjectId(req.params.id);
    if (!rid) return res.status(400).json({ message: "Invalid return id" });

    const doc = await Returns.findOne({ _id: rid });
    if (!doc) return res.status(404).json({ message: "Return not found" });

    const withAddr = await enrichReturnWithAddress(doc);
    const enriched = await enrichReturnWithCustomer(withAddr);

    return res.json({ return: enriched });
  }
);

/* ----------------------------- driver job peek + push ----------------------------- */

router.get(
  "/:id/driver-job",
  authMiddleware,
  isStaffMiddleware,
  ensureAdminRole("orders"),
  async (req, res) => {
    const rid = toObjectId(req.params.id);
    if (!rid) return res.status(400).json({ message: "Invalid return id" });

    const job = await DriverJobs.find({ returnId: rid })
      .sort({ updatedAt: -1, createdAt: -1 })
      .limit(1)
      .next();

    if (!job) return res.status(404).json({ message: "Driver job not found" });

    return res.json({
      job: {
        jobId: job._id,
        status: job.status,
        scope: job.scope || null,
        scopeKey: job.scopeKey || null,
        returnFlow: job.returnFlow || job.flow === "return" || null,
        driverId: job.driverId || null,
        driverName: job.driverName || job.driver?.name || null,
        updatedAt: job.updatedAt || job.modifiedAt || null,
        events: job.events || [],
        history: job.history || [],
      },
    });
  }
);

router.post(
  "/:id/driver-job/push",
  authMiddleware,
  isStaffMiddleware,
  ensureAdminRole("orders"),
  async (req, res) => {
    const rid = toObjectId(req.params.id);
    if (!rid) return res.status(400).json({ message: "Invalid return id" });

    const ret = await Returns.findOne({ _id: rid });
    if (!ret) return res.status(404).json({ message: "Return not found" });

    const jobInfo = await fetchLatestDriverJobInfo(ret._id);
    if (!jobInfo) return res.status(404).json({ message: "Driver job not found" });

    const pushAt = now();
    const jobUpdatedAt = jobInfo.updatedAt || pushAt;

    await Returns.updateOne(
      { _id: rid },
      {
        $set: {
          driverJob: jobInfo,
          "sync.latestDriverStatus": jobInfo.status,
          "sync.lastDriverEventAt": jobUpdatedAt,
          "sync.lastDriverJobId": jobInfo.jobId,
          "sync.lastPushedAt": pushAt,
          "sync.lastPushError": null,
          "sync.pushedToGlamzi": true,
        },
        $inc: { version: 1 },
      }
    );

    const updated = await Returns.findOne({ _id: rid });
    const withAddr = await enrichReturnWithAddress(updated);
    const enriched = await enrichReturnWithCustomer(withAddr);

    return res.json({ job: jobInfo, return: enriched });
  }
);

/* ----------------------------- decision (admin) ----------------------------- */
/**
 * PATCH /api/admin/returns/:id/decision
 * under_review -> approved_awaiting_pickup / rejected
 * Also sets qtyApproved per item.
 */
router.patch(
  "/:id/decision",
  authMiddleware,
  isStaffMiddleware,
  ensureAdminRole("orders"),
  async (req, res) => {
    const rid = toObjectId(req.params.id);
    if (!rid) return res.status(400).json({ message: "Invalid return id" });

    const actorId = String(req.user?._id || req.user?.id || "");
    const actorRole = actorRoleForTransitions(req, "admin");

    const decision = String(req.body?.decision || "").trim().toLowerCase(); // approved|rejected
    const notes = String(req.body?.notes || "").trim();
    const qtyApprovedByItem = req.body?.qtyApprovedByItem || {};

    const ret = await Returns.findOne({ _id: rid });
    if (!ret) return res.status(404).json({ message: "Return not found" });

    const cur = normalizeReturnStatus(ret.status);

    // If legacy docs still have "pending", normalize by moving to under_review first (admin-allowed).
    if (cur === RETURN_STATUS.pending) {
      if (!canTransitionReturnStatus(cur, RETURN_STATUS.under_review, actorRole)) {
        return res.status(409).json({ message: "Cannot move pending -> under_review" });
      }
      const ts0 = now();
      await Returns.updateOne(
        { _id: rid, status: ret.status },
        {
          $set: { status: RETURN_STATUS.under_review, statusUpdatedAt: ts0, updatedAt: ts0 },
          $push: { events: event({ kind: "admin", id: actorId }, "AUTO_UNDER_REVIEW", {}) },
        }
      );
    }

    const fresh = await Returns.findOne({ _id: rid });
    if (!fresh) return res.status(404).json({ message: "Return not found" });

    const statusNow = normalizeReturnStatus(fresh.status);

    if (statusNow !== RETURN_STATUS.under_review) {
      return res
        .status(409)
        .json({ message: `Decision allowed only from under_review (${fresh.status})` });
    }

    if (decision === "approved") {
      const next = RETURN_STATUS.approved_awaiting_pickup;
      if (!canTransitionReturnStatus(statusNow, next, actorRole)) {
        return res.status(409).json({ message: `Transition not allowed: ${statusNow} -> ${next}` });
      }

      const ts = now();
      const newItems = (fresh.items || []).map((it) => {
        const k = String(it.orderItemId || it._id || "");
        const fallbackApproved = Math.min(Number(it.qtyRequested || 0), Number(it.qtyOrdered || 0));
        const approved = Number(qtyApprovedByItem?.[k] ?? fallbackApproved);
        return { ...it, qtyApproved: Number.isFinite(approved) && approved >= 0 ? approved : 0 };
      });

      await Returns.updateOne(
        { _id: rid, status: fresh.status },
        {
          $set: {
            status: next,
            statusUpdatedAt: ts,
            updatedAt: ts,
            items: newItems,
            adminReview: {
              reviewedAt: ts,
              reviewedBy: { userId: actorId, role: "admin" },
              decision: "approved",
              notes,
            },
          },
          $push: { events: event({ kind: "admin", id: actorId }, "ADMIN_APPROVED", { notes }) },
        }
      );

      const orderLabel = fresh.orderNumber || fresh.orderId || "";
      try {
        await notifySeller({
          sellerId: fresh.sellerId,
          type: "return_approved",
          title: "Return approved",
          body: `Return approved for order ${orderLabel}`.trim(),
          link: "/seller/dashboard/orders/returns",
          meta: { returnId: String(rid), orderId: String(fresh.orderId || "") },
        });
      } catch (notifyErr) {
        console.error("Seller return approved notification error:", notifyErr);
      }

      try {
        await notifyCustomer({
          customerId: fresh.customerId,
          orderId: fresh.orderId,
          orderNumber: orderLabel,
          type: "return_approved",
          title: "Return approved",
          body: `Your return request for order ${orderLabel} was approved.`.trim(),
          link: "/returns",
          meta: { returnId: String(rid), orderId: String(fresh.orderId || "") },
        });
      } catch (notifyErr) {
        console.error("Customer return approved notification error:", notifyErr);
      }

      return res.json({ ok: true });
    }

    if (decision === "rejected") {
      const next = RETURN_STATUS.rejected;
      if (!canTransitionReturnStatus(statusNow, next, actorRole)) {
        return res.status(409).json({ message: `Transition not allowed: ${statusNow} -> ${next}` });
      }

      const ts = now();

      await Returns.updateOne(
        { _id: rid, status: fresh.status },
        {
          $set: {
            status: next,
            statusUpdatedAt: ts,
            updatedAt: ts,
            adminReview: {
              reviewedAt: ts,
              reviewedBy: { userId: actorId, role: "admin" },
              decision: "rejected",
              rejectionReason: String(req.body?.rejectionReason || "other"),
              notes,
            },
          },
          $push: { events: event({ kind: "admin", id: actorId }, "ADMIN_REJECTED", { notes }) },
        }
      );

      const orderLabel = fresh.orderNumber || fresh.orderId || "";
      try {
        await notifySeller({
          sellerId: fresh.sellerId,
          type: "return_rejected",
          title: "Return rejected",
          body: `Return rejected for order ${orderLabel}`.trim(),
          link: "/seller/dashboard/orders/returns",
          meta: { returnId: String(rid), orderId: String(fresh.orderId || "") },
        });
      } catch (notifyErr) {
        console.error("Seller return rejected notification error:", notifyErr);
      }

      try {
        await notifyCustomer({
          customerId: fresh.customerId,
          orderId: fresh.orderId,
          orderNumber: orderLabel,
          type: "return_rejected",
          title: "Return rejected",
          body: `Your return request for order ${orderLabel} was rejected.`.trim(),
          link: "/returns",
          meta: { returnId: String(rid), orderId: String(fresh.orderId || "") },
        });
      } catch (notifyErr) {
        console.error("Customer return rejected notification error:", notifyErr);
      }

      return res.json({ ok: true });
    }

    return res.status(400).json({ message: "decision must be approved or rejected" });
  }
);

/* ----------------------------- pickup booking (returnFlow) ----------------------------- */
/**
 * POST /api/admin/returns/:id/pickup/book
 * approved_awaiting_pickup -> pickup_scheduled
 */
router.post(
  "/:id/pickup/book",
  authMiddleware,
  isStaffMiddleware,
  ensureAdminRole("orders"),
  async (req, res) => {
    const rid = toObjectId(req.params.id);
    if (!rid) return res.status(400).json({ message: "Invalid return id" });

    const ret0 = await Returns.findOne({ _id: rid });
    if (!ret0) return res.status(404).json({ message: "Return not found" });

    const statusNow = normalizeReturnStatus(ret0.status);
    if (statusNow !== RETURN_STATUS.approved_awaiting_pickup) {
      return res.status(409).json({ message: `Cannot book pickup from status ${ret0.status}` });
    }

    const actorId = String(req.user?._id || req.user?.id || "");
    const actorRole = actorRoleForTransitions(req, "admin");

    // Fast idempotency: if already has active booking, return it
    if (ret0.pickup?.activeBookingId) {
      const existing = await ReturnShipments.findOne({ _id: ret0.pickup.activeBookingId });
      if (existing) return res.json({ booking: existing, idempotent: true });
    }

    assertShippingConfigured();

    const ts = now();
    const attempt = Number(ret0.pickup?.attempts || 0) + 1;
    const idempotencyKey = `return:${String(rid)}:partner:everestx:attempt:${attempt}`;

    const payloadSource = await enrichReturnWithAddress(ret0);
    const payload = buildReturnPickupPayload(payloadSource, { attempt, idempotencyKey });

    const driverId = safeStr(req.body?.driverId) || null;
    const driverAssignmentNote = String(req.body?.driverAssignmentNote || "").trim() || null;

    // Create booking doc first (so we always have a record even if partner call fails)
    const bookingDoc = {
      returnId: rid,
      orderId: ret0.orderId,
      sellerId: ret0.sellerId,
      partner: "everestx",
      returnFlow: true,
      isActive: true,
      attempt,
      idempotencyKey,
      payloadSnapshot: payload,
      booking: { bookedAt: ts, bookedBy: { kind: "admin", id: actorId } },
      status: "CREATED",
      events: [
        {
          at: ts,
          eventId: `local:${idempotencyKey}`,
          partnerStatus: "CREATED",
          mappedReturnStatus: RETURN_STATUS.pickup_scheduled,
          raw: { local: true },
        },
      ],
      createdAt: ts,
      updatedAt: ts,
    };

    let insertRes;
    try {
      insertRes = await ReturnShipments.insertOne(bookingDoc);
    } catch (e) {
      const active = await ReturnShipments.findOne({
        returnId: rid,
        partner: "everestx",
        isActive: true,
      });
      if (active) return res.json({ booking: active, idempotent: true });
      throw e;
    }

    // Call EverestX booking
    let shipResp;
    try {
      shipResp = await axios.post(
        `${SHIPPING_SERVICE_URL.replace(/\/+$/, "")}/api/shipments/book`,
        payload,
        {
          timeout: 15000,
          headers: {
            "Content-Type": "application/json",
            ...(SHIPPING_INTERNAL_TOKEN ? { "x-internal-token": SHIPPING_INTERNAL_TOKEN } : {}),
          },
        }
      );
    } catch (e) {
      const errMsg = String(e?.message || e);

      await logShippingBookingFailure({
        returnId: rid,
        orderId: ret0.orderId,
        attempt,
        payload,
        error: errMsg,
        status: e?.response?.status,
        response: e?.response?.data,
        stage: "book",
      });

      await ReturnShipments.updateOne(
        { _id: insertRes.insertedId },
        {
          $set: { status: "FAILED", updatedAt: now(), isActive: false },
          $push: {
            events: {
              at: now(),
              eventId: `err:${Date.now()}`,
              partnerStatus: "FAILED",
              mappedReturnStatus: null,
              raw: { error: errMsg },
            },
          },
        }
      );

      // Keep return in approved_awaiting_pickup
      await Returns.updateOne(
        { _id: rid },
        {
          $set: {
            updatedAt: now(),
            "pickup.lastBookingFailure": {
              at: now(),
              attempt,
              error: errMsg,
              partner: "everestx",
              status: e?.response?.status || null,
            },
            "pickup.attempts": attempt,
          },
          $push: {
            events: event({ kind: "admin", id: actorId }, "PICKUP_BOOK_FAILED", {
              attempt,
              error: errMsg,
              partnerStatus: e?.response?.status || null,
            }),
          },
        }
      );

      return res.status(502).json({ message: "Shipping booking failed", error: errMsg });
    }

    const trackingNumber =
      shipResp?.data?.trackingNumber ||
      shipResp?.data?.awb ||
      shipResp?.data?.waybill ||
      shipResp?.data?.shipment?.trackingNumber ||
      null;

    const externalShipmentId =
      shipResp?.data?.shipmentId ||
      shipResp?.data?._id ||
      shipResp?.data?.shipment?._id ||
      null;

    await ReturnShipments.updateOne(
      { _id: insertRes.insertedId },
      {
        $set: {
          trackingNumber,
          externalShipmentId,
          status: "BOOKED",
          updatedAt: now(),
          partnerResponseSnapshot: shipResp?.data || null,
          ...(driverId
            ? {
                assignedDriverId: driverId,
                driverAssignmentNote: driverAssignmentNote || null,
              }
            : {}),
        },
        $push: {
          events: {
            at: now(),
            eventId: `partner:${Date.now()}`,
            partnerStatus: "BOOKED",
            mappedReturnStatus: RETURN_STATUS.pickup_scheduled,
            raw: shipResp?.data || null,
          },
        },
      }
    );

    const next = RETURN_STATUS.pickup_scheduled;

    if (!canTransitionReturnStatus(statusNow, next, actorRole)) {
      return res.status(409).json({ message: `Transition not allowed: ${ret0.status} -> ${next}` });
    }

    const pickupSet = {
      status: next,
      statusUpdatedAt: now(),
      updatedAt: now(),
      "pickup.activeBookingId": insertRes.insertedId,
      "pickup.partner": "everestx",
      "pickup.latestTrackingNumber": trackingNumber,
      "pickup.latestExternalShipmentId": externalShipmentId,
      "pickup.bookedAt": ts,
      "pickup.lastEventAt": ts,
      "pickup.attempts": attempt,
      "pickup.lastBookingFailure": null,
      ...(driverId
        ? {
            "pickup.driverId": driverId,
            "pickup.driverAssignedAt": now(),
            "pickup.driverAssignmentNote": driverAssignmentNote || null,
          }
        : {}),
    };

    const eventEntries = [
      event({ kind: "admin", id: actorId }, "RETURN_PICKUP_BOOKED", { trackingNumber }),
    ];
    if (driverId) {
      eventEntries.push(
        event({ kind: "admin", id: actorId }, "RETURN_DRIVER_ASSIGNED", {
          driverId,
          note: driverAssignmentNote || null,
        })
      );
    }

    await Returns.updateOne(
      { _id: rid, status: ret0.status },
      { $set: pickupSet, $push: { events: { $each: eventEntries } } }
    );

    // IMPORTANT FIX: dispatch should use partner shipment id when present
    if (driverId) {
      try {
        await dispatchReturnDriverJob({
          driverId,
          shipmentId: externalShipmentId || insertRes.insertedId,
          trackingNumber,
          partner: "everestx",
          orderId: ret0.orderId,
          orderNumber: ret0.orderNumber,
          returnId: rid,
          actor: { role: "admin", id: actorId, name: req.user?.name || null },
          note: driverAssignmentNote,
        });
      } catch (err) {
        // non-fatal
        console.error("[admin returns] failed to assign driver via dispatch internal", err);
      }
    }

    const booking = await ReturnShipments.findOne({ _id: insertRes.insertedId });
    return res.json({ booking });
  }
);

/**
 * POST /api/admin/returns/:id/pickup/reschedule
 * - Allowed from approved_awaiting_pickup (rebook) OR pickup_scheduled (force=true)
 * - Status ends as pickup_scheduled (if booking succeeds)
 */
router.post(
  "/:id/pickup/reschedule",
  authMiddleware,
  isStaffMiddleware,
  ensureAdminRole("orders"),
  async (req, res) => {
    const rid = toObjectId(req.params.id);
    if (!rid) return res.status(400).json({ message: "Invalid return id" });

    const ret = await Returns.findOne({ _id: rid });
    if (!ret) return res.status(404).json({ message: "Return not found" });

    const actorId = String(req.user?._id || req.user?.id || "");
    const actorRole = actorRoleForTransitions(req, "admin");
    const force = Boolean(req.body?.force);

    const cur = normalizeReturnStatus(ret.status);

    const allowed =
      cur === RETURN_STATUS.approved_awaiting_pickup ||
      (cur === RETURN_STATUS.pickup_scheduled && force);

    if (!allowed) {
      return res.status(409).json({
        message:
          `Cannot reschedule from status ${ret.status}. Allowed: approved_awaiting_pickup, ` +
          `or pickup_scheduled with force=true`,
      });
    }

    assertShippingConfigured();

    // Deactivate previous active booking (if any)
    const prevActiveBookingId = ret.pickup?.activeBookingId;
    if (prevActiveBookingId) {
      await ReturnShipments.updateOne(
        { _id: prevActiveBookingId, isActive: true },
        { $set: { isActive: false, updatedAt: now() } }
      );
    }

    const ts = now();
    const attempt = Number(ret.pickup?.attempts || 0) + 1;
    const idempotencyKey = `return:${String(rid)}:partner:everestx:attempt:${attempt}`;

    const payloadSource = await enrichReturnWithAddress(ret);
    const payload = buildReturnPickupPayload(payloadSource, { attempt, idempotencyKey });

    const bookingDoc = {
      returnId: rid,
      orderId: ret.orderId,
      sellerId: ret.sellerId,
      partner: "everestx",
      returnFlow: true,
      isActive: true,
      attempt,
      idempotencyKey,
      rescheduleOf: prevActiveBookingId || null,
      payloadSnapshot: payload,
      booking: { bookedAt: ts, bookedBy: { kind: "admin", id: actorId } },
      status: "CREATED",
      events: [
        {
          at: ts,
          eventId: `local:${idempotencyKey}`,
          partnerStatus: "CREATED",
          mappedReturnStatus: RETURN_STATUS.pickup_scheduled,
          raw: { local: true, reschedule: true },
        },
      ],
      createdAt: ts,
      updatedAt: ts,
    };

    let insertRes;
    try {
      insertRes = await ReturnShipments.insertOne(bookingDoc);
    } catch (e) {
      const active = await ReturnShipments.findOne({
        returnId: rid,
        partner: "everestx",
        isActive: true,
      });
      if (active) return res.json({ booking: active, idempotent: true });
      throw e;
    }

    let shipResp;
    try {
      shipResp = await axios.post(
        `${SHIPPING_SERVICE_URL.replace(/\/+$/, "")}/api/shipments/book`,
        payload,
        {
          timeout: 15000,
          headers: {
            "Content-Type": "application/json",
            ...(SHIPPING_INTERNAL_TOKEN ? { "x-internal-token": SHIPPING_INTERNAL_TOKEN } : {}),
          },
        }
      );
    } catch (e) {
      const errMsg = String(e?.message || e);

      await logShippingBookingFailure({
        returnId: rid,
        orderId: ret.orderId,
        attempt,
        payload,
        error: errMsg,
        status: e?.response?.status,
        response: e?.response?.data,
        stage: "reschedule",
      });

      await ReturnShipments.updateOne(
        { _id: insertRes.insertedId },
        {
          $set: { status: "FAILED", updatedAt: now(), isActive: false },
          $push: {
            events: {
              at: now(),
              eventId: `err:${Date.now()}`,
              partnerStatus: "FAILED",
              mappedReturnStatus: null,
              raw: { error: errMsg, reschedule: true },
            },
          },
        }
      );

      // Keep current return status unchanged
      await Returns.updateOne(
        { _id: rid },
        {
          $set: {
            updatedAt: now(),
            "pickup.lastBookingFailure": {
              at: now(),
              attempt,
              error: errMsg,
              partner: "everestx",
              status: e?.response?.status || null,
            },
            "pickup.attempts": attempt,
          },
          $push: {
            events: event({ kind: "admin", id: actorId }, "PICKUP_RESCHEDULE_FAILED", {
              error: errMsg,
              attempt,
            }),
          },
        }
      );

      return res.status(502).json({ message: "Shipping booking failed", error: errMsg });
    }

    const trackingNumber =
      shipResp?.data?.trackingNumber ||
      shipResp?.data?.awb ||
      shipResp?.data?.waybill ||
      shipResp?.data?.shipment?.trackingNumber ||
      null;

    const externalShipmentId =
      shipResp?.data?.shipmentId ||
      shipResp?.data?._id ||
      shipResp?.data?.shipment?._id ||
      null;

    await ReturnShipments.updateOne(
      { _id: insertRes.insertedId },
      {
        $set: {
          trackingNumber,
          externalShipmentId,
          status: "BOOKED",
          updatedAt: now(),
          partnerResponseSnapshot: shipResp?.data || null,
        },
        $push: {
          events: {
            at: now(),
            eventId: `partner:${Date.now()}`,
            partnerStatus: "BOOKED",
            mappedReturnStatus: RETURN_STATUS.pickup_scheduled,
            raw: shipResp?.data || null,
          },
        },
      }
    );

    // Ensure return is pickup_scheduled after successful reschedule
    const nextStatus = RETURN_STATUS.pickup_scheduled;

    // If coming from approved_awaiting_pickup -> pickup_scheduled, validate transition
    if (cur === RETURN_STATUS.approved_awaiting_pickup) {
      if (!canTransitionReturnStatus(cur, nextStatus, actorRole)) {
        return res.status(409).json({
          message: `Transition not allowed: ${ret.status} -> ${nextStatus}`,
        });
      }
    }

    await Returns.updateOne(
      { _id: rid },
      {
        $set: {
          status: nextStatus,
          statusUpdatedAt: now(),
          updatedAt: now(),
          pickup: {
            ...(ret.pickup || {}),
            activeBookingId: insertRes.insertedId,
            partner: "everestx",
            latestTrackingNumber: trackingNumber,
            latestExternalShipmentId: externalShipmentId,
            bookedAt: ts,
            lastEventAt: now(),
            attempts: attempt,
            rescheduleReason: String(req.body?.reason || ""),
            lastBookingFailure: null,
          },
        },
        $push: {
          events: event({ kind: "admin", id: actorId }, "RETURN_PICKUP_RESCHEDULED", {
            attempt,
            reason: req.body?.reason || null,
            trackingNumber,
          }),
        },
      }
    );

    const booking = await ReturnShipments.findOne({ _id: insertRes.insertedId });
    return res.json({ booking, rescheduled: true });
  }
);

/* ----------------------------- refund issue (finance) ----------------------------- */
/**
 * POST /api/admin/returns/:id/refund/issue
 * received_by_seller -> refunded (finance/admin)
 *
 * Gate:
 * - status must be received_by_seller
 * - seller receipt must exist
 */
router.post(
  "/:id/refund/issue",
  authMiddleware,
  isStaffMiddleware,
  ensureAdminRole("finance"),
  async (req, res) => {
    const rid = toObjectId(req.params.id);
    if (!rid) return res.status(400).json({ message: "Invalid return id" });

    const actorId = String(req.user?._id || req.user?.id || "");
    const actorRole = "admin"; // finance mapped to admin
    const idempotencyKey = `refund:return:${String(rid)}`;

    const session = client.startSession();
    try {
      let result;

      await session.withTransaction(async () => {
        const ret = await Returns.findOne({ _id: rid }, { session });
        if (!ret) throw new Error("RETURN_NOT_FOUND");

        const cur = normalizeReturnStatus(ret.status);
        // Require inspection_approved before issuing refund
        if (cur !== RETURN_STATUS.inspection_approved) {
          throw new Error(`INVALID_STATUS:${ret.status}`);
        }

        const receivedAt =
          ret?.seller?.receipt?.receivedAt ||
          ret?.sellerReceipt?.receivedConfirmedAt ||
          ret?.sellerReceipt?.receivedAt ||
          ret?.seller?.receipt?.confirmedAt ||
          null;

        if (!receivedAt) throw new Error("MISSING_SELLER_RECEIPT");

        const existing = await Refunds.findOne({ idempotencyKey }, { session });
        if (existing) {
          result = { idempotent: true, refund: existing };
          return;
        }

        const next = RETURN_STATUS.refund_queued;
        if (!canTransitionReturnStatus(cur, next, actorRole)) {
          throw new Error(`CANNOT_TRANSITION:${ret.status}->${next}`);
        }

        const ts = now();

        const orderIdObj =
          ret.orderId && ObjectId.isValid(ret.orderId)
            ? new ObjectId(ret.orderId)
            : ret.orderId || null;

        const orderDoc = orderIdObj ? await Orders.findOne({ _id: orderIdObj }, { session }) : null;

        const paymentMethodRaw = String(orderDoc?.paymentMethod || orderDoc?.payment?.method || "")
          .trim()
          .toLowerCase();

        const paymentMethod = paymentMethodRaw || "unknown";

        const codSettlementStatusRaw = String(
          orderDoc?.cod?.settlementStatus || orderDoc?.payment?.codSettlementStatus || "unknown"
        )
          .trim()
          .toLowerCase();

        const codSettlementStatus = codSettlementStatusRaw || "unknown";
        const codBatchId = orderDoc?.cod?.settledBatchId || orderDoc?.payment?.codBatchId || null;

        const overrideMethod = String(req.body?.method || "").trim();
        let refundMethod = overrideMethod;

        if (!refundMethod) {
          if (paymentMethod === "online" || paymentMethod === "prepaid") {
            refundMethod = "prepaid_reversal";
          } else if (paymentMethod === "cod") {
            if (codSettlementStatus === "unsettled") refundMethod = "cod_adjustment";
            else if (codSettlementStatus === "settled") refundMethod = "manual";
            else throw new Error("REFUND_METHOD_REQUIRED");
          } else {
            throw new Error("REFUND_METHOD_REQUIRED");
          }
        }

        const paymentContext = { paymentMethod, codSettlementStatus, codBatchId };
        const amounts = computeRefundAmounts(ret);

        const refundDoc = {
          refundNumber: `RFD-${ts.getFullYear()}-${Math.random()
            .toString(16)
            .slice(2, 8)
            .toUpperCase()}`,
          returnId: rid,
          orderId: ret.orderId,
          orderNumber: ret.orderNumber,
          sellerId: ret.sellerId,
          customerId: ret.customerId,
          currency: amounts.currency,
          method: refundMethod,
          paymentContext,
          amounts,
          gate: {
            sellerReceivedAt: receivedAt,
            issuedBy: { kind: "finance", id: actorId },
          },
          status: "queued",
          provider: {
            name: String(req.body?.providerName || "manual"),
            reference: String(req.body?.providerRef || ""),
            raw: req.body?.providerRaw || null,
          },
          idempotencyKey,
          ledgerEntryIds: [],
          createdAt: ts,
          updatedAt: ts,
        };

        const ins = await Refunds.insertOne(refundDoc, { session });
        refundDoc._id = ins.insertedId;

        const ledgerIds = await createLedgerEntriesForRefund({
          ret,
          refundDoc,
          paymentContext,
          session,
        });

        await Refunds.updateOne(
          { _id: refundDoc._id },
          { $set: { ledgerEntryIds: ledgerIds, updatedAt: now() } },
          { session }
        );

        await Returns.updateOne(
          { _id: rid, status: ret.status },
          {
            $set: {
              status: next,
              statusUpdatedAt: ts,
              updatedAt: ts,
              refund: {
                refundId: refundDoc._id,
                currency: refundDoc.currency,
                refundableTotal: refundDoc.amounts.total,
                method: refundMethod,
                issuedAt: ts,
                issuedBy: { kind: "finance", id: actorId },
              },
            },
            $push: {
              events: event({ kind: "finance", id: actorId }, "REFUND_ISSUED", {
                refundId: String(refundDoc._id),
                method: refundMethod,
                total: refundDoc.amounts.total,
              }),
            },
          },
          { session }
        );

        result = { idempotent: false, refund: refundDoc };
      });

      return res.json({ ok: true, ...result });
    } catch (e) {
      const msg = String(e?.message || e);
      if (msg === "RETURN_NOT_FOUND") return res.status(404).json({ message: "Return not found" });
      if (msg.startsWith("INVALID_STATUS:")) return res.status(409).json({ message: msg });
      if (msg === "REFUND_METHOD_REQUIRED") {
        return res
          .status(409)
          .json({ message: "Refund method required for this payment context" });
      }
      if (msg.startsWith("CANNOT_TRANSITION:")) return res.status(409).json({ message: msg });
      if (msg === "MISSING_SELLER_RECEIPT")
        return res.status(409).json({ message: "Seller receipt is required" });
      return res.status(400).json({ message: "Refund issue failed", error: msg });
    } finally {
      await session.endSession();
    }
  }
);

/**
 * REFUND COMPLETE (finance/admin)
 * POST /api/admin/returns/:id/refund/complete
 * Gate: status must be refund_queued
 */
router.post(
  "/:id/refund/complete",
  authMiddleware,
  isStaffMiddleware,
  ensureAdminRole("finance"),
  async (req, res) => {
    const rid = toObjectId(req.params.id);
    if (!rid) return res.status(400).json({ message: "Invalid return id" });

    const actor = {
      role: "admin",
      userId: String(req.user?._id || req.user?.id || ""),
      name: req.user?.name || req.user?.email || null,
    };

    const session = client.startSession();
    try {
      let result;

      await session.withTransaction(async () => {
        const ret = await Returns.findOne({ _id: rid }, { session });
        if (!ret) throw new Error("RETURN_NOT_FOUND");

        const cur = normalizeReturnStatus(ret.status);
        if (cur !== RETURN_STATUS.refund_queued) {
          throw new Error(`INVALID_STATUS:${ret.status}`);
        }

        const refundDoc = await Refunds.findOne(
          { returnId: rid, status: { $in: ["queued", "pending"] } },
          { session }
        );
        if (!refundDoc) throw new Error("REFUND_NOT_FOUND");

        const next = RETURN_STATUS.refunded;
        if (!canTransitionReturnStatus(cur, next, actor.role)) {
          throw new Error(`CANNOT_TRANSITION:${ret.status}->${next}`);
        }

        const ts = now();

        await Refunds.updateOne(
          { _id: refundDoc._id },
          {
            $set: {
              status: "completed",
              completedAt: ts,
              updatedAt: ts,
              "provider.reference": safeStr(req.body?.providerRef) || refundDoc.provider?.reference || "",
              "provider.name":
                safeStr(req.body?.providerName) || refundDoc.provider?.name || "manual",
            },
          },
          { session }
        );

        const updated = await casReturnStatus({
          Returns,
          returnId: rid,
          expectedStatus: cur,
          nextStatus: next,
          actor,
          extraSet: {
            "refund.status": "completed",
            "refund.completedAt": ts,
            updatedAt: ts,
          },
          extraPushHistory: { message: "Refund completed." },
        });

        result = { refundCompleted: true, return: updated };
      });

      return res.json({ ok: true, ...result });
    } catch (err) {
      console.error("POST refund complete error:", err);
      const msg = String(err?.message || err);
      if (msg === "RETURN_NOT_FOUND") return res.status(404).json({ message: "Return not found" });
      if (msg === "REFUND_NOT_FOUND") return res.status(404).json({ message: "Refund not found" });
      if (msg.startsWith("INVALID_STATUS:") || msg.startsWith("CANNOT_TRANSITION:")) {
        return res.status(409).json({ message: msg });
      }
      return res.status(err.statusCode || 500).json({ message: err.message || "Server error" });
    } finally {
      await session.endSession();
    }
  }
);

/**
 * ADMIN INSPECTION DECISION (after seller receipt)
 * PATCH /api/admin/returns/:id/inspection
 * Allowed from: received_by_seller or delivered_to_seller
 * Decision: approve | reject
 */
router.patch(
  "/:id/inspection",
  authMiddleware,
  isStaffMiddleware,
  ensureAdminRole("admin"),
  async (req, res) => {
    const rid = toObjectId(req.params.id);
    if (!rid) return res.status(400).json({ message: "Invalid return id" });

    const decision = String(req.body?.decision || "").trim().toLowerCase();
    if (!["approve", "reject"].includes(decision)) {
      return res.status(400).json({ message: "decision must be approve or reject" });
    }

    const doc = await Returns.findOne({ _id: rid });
    if (!doc) return res.status(404).json({ message: "Not found" });

    const cur = normalizeReturnStatus(doc.status);
    const allowedCurrent = new Set([
      RETURN_STATUS.received_by_seller,
      RETURN_STATUS.delivered_to_seller,
    ]);
    if (!allowedCurrent.has(cur)) {
      return res
        .status(409)
        .json({ message: "Inspection decision allowed only after receipt", status: doc.status });
    }

    const next =
      decision === "approve" ? RETURN_STATUS.inspection_approved : RETURN_STATUS.inspection_rejected;

    if (!canTransitionReturnStatus(cur, next, "admin")) {
      return res.status(409).json({ message: `Cannot transition ${cur} -> ${next}` });
    }

    const actor = {
      role: "admin",
      userId: String(req.user?._id || req.user?.id || ""),
      name: req.user?.name || req.user?.email || null,
    };

    const note = safeStr(req.body?.note, 800);

    const updated = await casReturnStatus({
      Returns,
      returnId: rid,
      expectedStatus: cur,
      nextStatus: next,
      actor,
      extraSet: {
        "inspection.decidedAt": now(),
        "inspection.decidedBy": { userId: actor.userId, name: actor.name },
        "inspection.note": note || null,
      },
      extraPushHistory: { message: `Admin ${decision} inspection.` },
    });

    return res.json({ return: updated });
  }
);

/* ----------------------------- pickup proof ----------------------------- */

function sanitizeProof(body) {
  if (!body?.url || !body?.kind || !body?.type) return null;
  return {
    kind: String(body.kind).trim(),
    type: String(body.type).trim(),
    url: String(body.url).trim(),
    capturedAt: body.capturedAt ? new Date(body.capturedAt) : new Date(),
    capturedBy:
      body.capturedBy && typeof body.capturedBy === "object"
        ? {
            role: String(body.capturedBy.role || "").trim(),
            id: String(body.capturedBy.id || "").trim(),
          }
        : null,
    meta: body.meta && typeof body.meta === "object" ? body.meta : null,
  };
}

router.post(
  "/:id/pickup/proof",
  authMiddleware,
  isStaffMiddleware,
  ensureAdminRole("orders"),
  async (req, res) => {
    const rid = toObjectId(req.params.id);
    if (!rid) return res.status(400).json({ message: "Invalid return id" });

    const proof = sanitizeProof(req.body);
    if (!proof) return res.status(400).json({ message: "Invalid proof payload" });

    const ret = await Returns.findOne({ _id: rid });
    if (!ret) return res.status(404).json({ message: "Return not found" });

    const bookingId = ret.pickup?.activeBookingId;
    if (!bookingId) return res.status(409).json({ message: "No active booking to attach proof" });

    const note = String(req.body?.note || "").trim();
    const eventId = `proof:${Date.now()}`;

    const ev = {
      at: proof.capturedAt,
      eventId,
      partnerStatus: null,
      mappedReturnStatus: null,
      raw: { proofs: [proof], note },
    };

    await ReturnShipments.updateOne(
      { _id: bookingId },
      { $push: { events: ev }, $set: { updatedAt: now() } }
    );

    await Returns.updateOne(
      { _id: rid },
      {
        $set: {
          "pickup.proof.latest": {
            kind: proof.kind,
            type: proof.type,
            url: proof.url,
            capturedAt: proof.capturedAt,
            capturedBy: proof.capturedBy,
          },
          updatedAt: now(),
        },
        $inc: { "pickup.proof.count": 1 },
      }
    );

    return res.json({ ok: true, proof: ev.raw.proofs[0] });
  }
);

/* ----------------------------- dispute (admin) ----------------------------- */

function normalizeEvidence(body) {
  if (!body) return null;
  const proofUrls = Array.isArray(body.proofUrls)
    ? body.proofUrls.map(String).map((s) => s.trim()).filter(Boolean)
    : [];
  const notes = safeStr(body.notes) || null;
  const reason = safeStr(body.reason) || safeStr(body.reasonCode) || null;
  return { reason, notes, proofUrls };
}

/**
 * PATCH /api/admin/returns/:id/dispute/open
 * Opens a dispute record on the return (non-stateful, but auditable).
 */
router.patch(
  "/:id/dispute/open",
  authMiddleware,
  isStaffMiddleware,
  ensureAdminRole("orders"),
  async (req, res) => {
    const rid = toObjectId(req.params.id);
    if (!rid) return res.status(400).json({ message: "Invalid return id" });

    const actorId = String(req.user?._id || req.user?.id || "");
    const ts = now();

    const ret = await Returns.findOne({ _id: rid });
    if (!ret) return res.status(404).json({ message: "Return not found" });

    const evidence = normalizeEvidence(req.body?.evidence || req.body);

    await Returns.updateOne(
      { _id: rid },
      {
        $set: {
          "dispute.isOpen": true,
          "dispute.openedAt": ts,
          "dispute.openedBy": { kind: "admin", id: actorId },
          "dispute.evidence": evidence,
          updatedAt: ts,
        },
        $push: {
          events: event({ kind: "admin", id: actorId }, "DISPUTE_OPENED", { evidence }),
        },
        $inc: { version: 1 },
      }
    );

    const updated = await Returns.findOne({ _id: rid });
    return res.json({ ok: true, return: updated });
  }
);

/**
 * PATCH /api/admin/returns/:id/dispute/resolve
 * Resolves dispute record and optionally stores resolution notes.
 */
router.patch(
  "/:id/dispute/resolve",
  authMiddleware,
  isStaffMiddleware,
  ensureAdminRole("orders"),
  async (req, res) => {
    const rid = toObjectId(req.params.id);
    if (!rid) return res.status(400).json({ message: "Invalid return id" });

    const actorId = String(req.user?._id || req.user?.id || "");
    const ts = now();

    const ret = await Returns.findOne({ _id: rid });
    if (!ret) return res.status(404).json({ message: "Return not found" });

    const resolution = {
      decision: safeStr(req.body?.decision) || "resolved",
      notes: safeStr(req.body?.notes) || null,
      outcome: safeStr(req.body?.outcome) || null,
    };

    await Returns.updateOne(
      { _id: rid },
      {
        $set: {
          "dispute.isOpen": false,
          "dispute.resolvedAt": ts,
          "dispute.resolvedBy": { kind: "admin", id: actorId },
          "dispute.resolution": resolution,
          updatedAt: ts,
        },
        $push: {
          events: event({ kind: "admin", id: actorId }, "DISPUTE_RESOLVED", resolution),
        },
        $inc: { version: 1 },
      }
    );

    const updated = await Returns.findOne({ _id: rid });
    return res.json({ ok: true, return: updated });
  }
);

/* ----------------------------- SLA (admin) ----------------------------- */

/**
 * PATCH /api/admin/returns/:id/sla/escalate
 * Marks SLA escalation metadata. Does not force status change.
 */
router.patch(
  "/:id/sla/escalate",
  authMiddleware,
  isStaffMiddleware,
  ensureAdminRole("orders"),
  async (req, res) => {
    const rid = toObjectId(req.params.id);
    if (!rid) return res.status(400).json({ message: "Invalid return id" });

    const actorId = String(req.user?._id || req.user?.id || "");
    const ts = now();

    const ret = await Returns.findOne({ _id: rid });
    if (!ret) return res.status(404).json({ message: "Return not found" });

    const reason = safeStr(req.body?.reason) || "manual_escalation";
    const note = safeStr(req.body?.note) || null;
    const level = safeStr(req.body?.level) || "L1";

    await Returns.updateOne(
      { _id: rid },
      {
        $set: {
          "sla.escalated": true,
          "sla.escalatedAt": ts,
          "sla.escalation": {
            level,
            reason,
            note,
            escalatedBy: { kind: "admin", id: actorId },
            at: ts,
          },
          updatedAt: ts,
        },
        $push: {
          events: event({ kind: "admin", id: actorId }, "SLA_ESCALATED", { level, reason, note }),
        },
        $inc: { version: 1 },
      }
    );

    const updated = await Returns.findOne({ _id: rid });
    return res.json({ ok: true, return: updated });
  }
);

export default router;
