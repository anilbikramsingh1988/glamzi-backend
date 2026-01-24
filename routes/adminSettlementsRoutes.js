// routes/adminSettlementsRoutes.js (ESM)
// ✅ Finance-only access (finance + super-admin)
// ✅ IMPORTANT: All "flat" routes are defined BEFORE any potential greedy "/:id" routes
// ✅ Payout Queue (eligible invoices) + Payout Batches + Seller Payout Accounts
// ✅ Batch creation uses Mongo transaction + invoice locking to prevent races
// ✅ Seller payoutHold is enforced: held sellers are excluded from payout queue + batches

import express from "express";
import { ObjectId } from "mongodb";
import { client } from "../dbConfig.js";
import { authMiddleware } from "../middlewares/authMiddleware.js";

const router = express.Router();

const dbName = process.env.DB_NAME || "everest_logistic";
const db = client.db(dbName);

const Invoices = db.collection("invoices");
const Users = db.collection("users");
const SettlementBatches = db.collection("settlementBatches");
const SettlementAuditLogs = db.collection("settlementAuditLogs");
const InvoiceAuditLogs = db.collection("invoiceAuditLogs");
const SettlementPeriods = db.collection("settlementPeriods");
const SellerSettlements = db.collection("sellerSettlements");
const LedgerEntries = db.collection("ledgerEntries");

// Frontend alias compatibility (/payout-batches -> /batches)
router.use("/settlements/payout-batches", (req, res, next) => {
  req.url = req.url.replace("payout-batches", "batches");
  next();
});

/* ===============================
   ROLE GUARD (finance-only)
   Roles allowed: super-admin, finance
=============================== */
function ensureFinanceAccess(req, res, next) {
  const role = String(req?.user?.role || "").toLowerCase();
  const allowed = ["super-admin", "finance"];
  if (!allowed.includes(role)) {
    return res.status(403).json({ message: "Forbidden: finance access required" });
  }
  next();
}

/* ===============================
   HELPERS
=============================== */
function toObjectId(id) {
  if (!id) return null;
  try {
    if (id instanceof ObjectId) return id;
    const s = String(id).trim();
    if (!ObjectId.isValid(s)) return null;
    return new ObjectId(s);
  } catch {
    return null;
  }
}

function safeString(v, max = 200) {
  if (typeof v !== "string") return "";
  const s = v.trim();
  return s.length > max ? s.slice(0, max) : s;
}

function parseIntSafe(v, fallback) {
  const n = Number.parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function escapeRegex(str) {
  return String(str || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function moneyNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/* ===============================
   NEW helpers (for frontend alignment)
=============================== */
function normalizePayoutMethod(m) {
  const v = String(m || "").toLowerCase();
  const allowed = new Set([
    "bank_transfer",
    "esewa",
    "khalti",
    "imepay",
    "cheque",
    "cash",
    "other",
  ]);
  return allowed.has(v) ? v : "bank_transfer";
}

function parsePaidAt(v) {
  if (!v) return null;
  const dt = new Date(v);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

function parseDateValue(v) {
  if (!v) return null;
  const dt = new Date(v);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

function boolish(v, fallback = false) {
  if (typeof v === "boolean") return v;
  const str = String(v ?? "").trim().toLowerCase();
  if (!str) return fallback;
  if (["1", "true", "yes", "y", "on"].includes(str)) return true;
  if (["0", "false", "no", "n", "off"].includes(str)) return false;
  return fallback;
}

function csvCell(value) {
  const str = value == null ? "" : String(value);
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

// Invoice "paid" detection (flexible) — UPDATED
function isInvoicePaid(inv) {
  const s = String(inv?.status || "").toLowerCase();
  const ps = String(inv?.paymentStatus || inv?.payment?.status || "").toLowerCase();
  // support paidAt shapes used in frontend normalization
  const paidAt = inv?.paidAt || inv?.payment?.paidAt;
  return s === "paid" || ps === "paid" || Boolean(paidAt);
}

// Invoice "completed/delivered" detection (flexible)
function isInvoiceCompleted(inv) {
  const ds = String(inv?.deliveryStatus || inv?.orderStatus || "").toLowerCase();
  return ["completed", "delivered"].includes(ds);
}

// inv.commissionPayout: { status, batchId, paidAt, ref, note, updatedAt }
function getPayoutStatus(inv) {
  return String(inv?.commissionPayout?.status || "pending").toLowerCase();
}

function isEligibleForPayout(inv) {
  if (!isInvoicePaid(inv)) return false;
  if (!isInvoiceCompleted(inv)) return false;

  const ps = getPayoutStatus(inv);
  return !["processing", "paid"].includes(ps);
}

async function auditLog(coll, doc) {
  try {
    await coll.insertOne({ ...doc, createdAt: new Date() });
  } catch {
    // never block business flow
  }
}

/* =========================================================
   0) NOTE ABOUT ROUTE ORDERING
   These routes MUST stay ABOVE any "/settlements/:id" or "/:id" style routes.
========================================================= */

/* =========================================================
   1) PAYOUT QUEUE (Eligible Invoices)
   GET /api/admin/settlements/payout-queue
   Query: page, limit, q, sellerId, from, to
========================================================= */
router.get("/settlements/payout-queue", authMiddleware, ensureFinanceAccess, async (req, res) => {
  try {
    const page = parseIntSafe(req.query.page, 1);
    const limit = parseIntSafe(req.query.limit, 20);
    const q = safeString(req.query.q, 200);
    const sellerId = safeString(req.query.sellerId, 80);
    const from = safeString(req.query.from, 30);
    const to = safeString(req.query.to, 30);

    const match = {};

    // Date filter (createdAt on invoice)
    if (from || to) {
      match.createdAt = {};
      if (from) match.createdAt.$gte = new Date(from);
      if (to) {
        const dt = new Date(to);
        dt.setHours(23, 59, 59, 999);
        match.createdAt.$lte = dt;
      }
    }

    if (sellerId) match.sellerId = sellerId;

    if (q) {
      const rx = new RegExp(escapeRegex(q), "i");
      match.$or = [
        { invoiceNumber: rx },
        { orderId: rx },
        { "buyer.name": rx },
        { "buyer.email": rx },
        { sellerName: rx },
        { sellerId: rx },
        { reference: rx },
        { note: rx },
        { "commissionPayout.ref": rx },
      ];
    }

    const pipeline = [
      { $match: match },

      // Compute eligibility flags + totals
      {
        $addFields: {
          _paymentMethodLower: {
            $toLower: { $ifNull: ["$paymentMethod", ""] },
          },
          _isPaid: {
            $or: [
              { $eq: [{ $toLower: { $ifNull: ["$status", ""] } }, "paid"] },
              { $eq: [{ $toLower: { $ifNull: ["$paymentStatus", ""] } }, "paid"] },
              { $eq: [{ $toLower: { $ifNull: ["$payment.status", ""] } }, "paid"] },
              { $gt: ["$paidAt", null] },
              { $gt: ["$payment.paidAt", null] },
              { $gt: ["$esewa.paidAt", null] },
              // Treat eSewa invoices as paid once created (they're prepaid)
              { $eq: [{ $toLower: { $ifNull: ["$paymentMethod", ""] } }, "esewa"] },
              { $eq: [{ $toLower: { $ifNull: ["$payment.method", ""] } }, "esewa"] },
            ],
          },
          _isCompleted: {
            $in: [
              { $toLower: { $ifNull: ["$deliveryStatus", "$orderStatus"] } },
              ["completed", "delivered"],
            ],
          },
          _payoutStatus: { $toLower: { $ifNull: ["$commissionPayout.status", "pending"] } },

          grossTotal: {
            $ifNull: [
              "$totals.gross",
              { $ifNull: ["$grossTotal", { $ifNull: ["$grandTotal", { $ifNull: ["$totalAmount", 0] }] }] },
            ],
          },
          commissionTotal: {
            $ifNull: [
              "$totals.commission",
              {
                $ifNull: [
                  "$commissionTotal",
                  {
                    $ifNull: [
                      "$commissionAmount",
                      {
                        $subtract: [
                          {
                            $ifNull: [
                              "$totals.gross",
                              { $ifNull: ["$grossTotal", 0] },
                            ],
                          },
                          {
                            $ifNull: [
                              "$totals.net",
                              { $ifNull: ["$netPayout", 0] },
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
        },
      },
      {
        $addFields: {
          netPayout: {
            $ifNull: [
              "$totals.net",
              {
                $ifNull: [
                  "$netPayout",
                  {
                    $subtract: [
                      "$grossTotal",
                      {
                        $ifNull: ["$commissionTotal", 0],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        },
      },

      // Returns (all-time, until batched): join returns collection by orderId/orderNumber
      {
        $lookup: {
          from: "returns",
          let: { oid: "$orderId", orderNumber: "$orderNumber" },
          pipeline: [
            {
              $match: {
                $expr: {
                  $or: [
                    { $eq: ["$orderId", "$$oid"] },
                    { $eq: [{ $toString: "$orderId" }, { $toString: "$$oid" }] },
                    { $eq: ["$orderNumber", "$$orderNumber"] },
                  ],
                },
              },
            },
            {
              $match: {
                status: {
                  $in: [
                    "refund_queued",
                    "refunded",
                    "delivered",
                    "received_by_seller",
                    "inspection_approved",
                    "inspection_rejected",
                  ],
                },
              },
            },
            {
              $project: {
                _id: 0,
                amount: {
                  $ifNull: [
                    "$refund.amounts.total",
                    "$refund.totalRefund",
                    "$refund.amount",
                    "$request.pricing.totalPaidForReturnLine",
                    "$request.pricing.totalPaid",
                    { $ifNull: ["$pricing.totalPaidForReturnLine", 0] },
                    0,
                  ],
                },
              },
            },
            { $group: { _id: null, total: { $sum: "$amount" } } },
          ],
          as: "returnsAgg",
        },
      },
      {
        $addFields: {
          returnsTotal: { $ifNull: [{ $first: "$returnsAgg.total" }, 0] },
        },
      },
      { $project: { returnsAgg: 0 } },

      // Eligibility: paid + completed + payoutStatus not processing/paid
      {
        $match: {
          _isPaid: true,
          _isCompleted: true,
          _payoutStatus: { $nin: ["processing", "paid"] },
        },
      },

      // Join seller (for payoutHold enforcement + UI)
      {
        $lookup: {
          from: "users",
          let: { sid: "$sellerId" },
          pipeline: [
            {
              $match: {
                $expr: {
                  $or: [
                    // sellerId is string of ObjectId
                    { $eq: [{ $toString: "$_id" }, "$$sid"] },
                    // fallback: some datasets store sellerId field on user
                    { $eq: ["$sellerId", "$$sid"] },
                  ],
                },
              },
            },
            {
              $project: {
                _id: 1,
                storeName: 1,
                shopName: 1,
                email: 1,
                payout: 1,
                payoutHold: 1,
              },
            },
          ],
          as: "seller",
        },
      },
      { $addFields: { seller: { $first: "$seller" } } },

      // Enforce payoutHold: exclude held sellers from queue
      {
        $match: {
          $or: [{ "seller.payoutHold": { $ne: true } }, { seller: { $eq: null } }],
        },
      },

      { $sort: { createdAt: -1 } },
      {
        $facet: {
          items: [
            { $skip: (page - 1) * limit },
            { $limit: limit },
            {
              $project: {
                _id: 1,
                invoiceNumber: 1,
                orderId: 1,
                sellerId: 1,
                sellerName: 1,
                status: 1,
                paymentStatus: 1,
                deliveryStatus: 1,
                orderStatus: 1,
                createdAt: 1,
                grossTotal: 1,
                commissionTotal: 1,
                netPayout: 1,
                commissionPayout: 1,
                seller: 1,
                returnsTotal: 1,
              },
            },
          ],
          meta: [{ $count: "total" }],
          summary: [
            {
              $group: {
                _id: null,
                totalInvoices: { $sum: 1 },
                totalGross: { $sum: "$grossTotal" },
                totalCommission: { $sum: "$commissionTotal" },
                totalNetPayout: { $sum: "$netPayout" },
                totalReturns: { $sum: "$returnsTotal" },
              },
            },
          ],
        },
      },
    ];

    const agg = await Invoices.aggregate(pipeline).toArray();
    const out = agg?.[0] || {};
    const items = out.items || [];
    const total = out.meta?.[0]?.total || 0;
    const sum = out.summary?.[0] || {};

    return res.json({
      items,
      total,
      page,
      limit,
      summary: {
        totalInvoices: Number(sum.totalInvoices || 0),
        totalGross: moneyNum(sum.totalGross),
        totalCommission: moneyNum(sum.totalCommission),
        totalNetPayout: moneyNum(sum.totalNetPayout),
      },
    });
  } catch (err) {
    console.error("payout-queue error:", err);
    return res.status(500).json({ message: "Failed to load payout queue" });
  }
});

/* =========================================================
   2) CREATE PAYOUT BATCH
   POST /api/admin/settlements/batches
   Body: { invoiceIds: [], note?, reference? }
   - Locks invoices into commissionPayout.status="processing"
========================================================= */
router.post("/settlements/batches", authMiddleware, ensureFinanceAccess, async (req, res) => {
  const session = client.startSession();
  try {
    const invoiceIds = Array.isArray(req.body.invoiceIds) ? req.body.invoiceIds : [];
    const note = safeString(req.body.note, 500);
    const reference = safeString(req.body.reference, 120);

    if (!invoiceIds.length) return res.status(400).json({ message: "invoiceIds[] is required" });

    const oidList = invoiceIds.map((id) => toObjectId(id)).filter(Boolean);
    if (!oidList.length) return res.status(400).json({ message: "No valid invoice IDs provided" });

    let createdBatch = null;

    await session.withTransaction(async () => {
      const invoices = await Invoices.find({ _id: { $in: oidList } }, { session }).toArray();
      if (invoices.length !== oidList.length) throw new Error("One or more invoices not found");

      // Must be eligible & not held by seller payoutHold
      const sellerIds = [
        ...new Set(invoices.map((x) => String(x?.sellerId || "").trim()).filter(Boolean)),
      ];
      const sellers = sellerIds.length
        ? await Users.find({ _id: { $in: sellerIds.map((s) => toObjectId(s)).filter(Boolean) } }, { session })
            .project({ _id: 1, payoutHold: 1 })
            .toArray()
        : [];

      const holdSet = new Set(
        sellers.filter((u) => u?.payoutHold === true).map((u) => String(u?._id))
      );

      const ineligible = invoices.filter((inv) => {
        const eligible = isEligibleForPayout(inv);
        const sid = String(inv?.sellerId || "");
        const held = holdSet.has(sid);
        return !eligible || held;
      });

      if (ineligible.length) {
        const sample = ineligible.slice(0, 5).map((x) => String(x._id)).join(", ");
        throw new Error(`Some invoices are not eligible for payout (or seller is on hold): ${sample}`);
      }

      const totals = invoices.reduce(
        (acc, inv) => {
          const gross = moneyNum(
            inv?.sellerTotals?.subtotalBase ??
              inv?.totals?.gross ??
              inv?.grossTotal ??
              inv?.grandTotal ??
              inv?.totalAmount ??
              0
          );
          const commissionRaw =
            inv?.totals?.commission ??
            inv?.commissionTotal ??
            inv?.commissionAmount ??
            null;
          const comm = moneyNum(
            Number.isFinite(commissionRaw)
              ? commissionRaw
              : inv?.sellerTotals
              ? moneyNum(gross - moneyNum(inv?.sellerTotals?.grandTotal ?? gross))
              : 0
          );
          const net = moneyNum(
            inv?.sellerTotals?.grandTotal ??
              inv?.totals?.net ??
              inv?.netPayout ??
              (gross - comm)
          );
          acc.totalGross += gross;
          acc.totalCommission += comm;
          acc.totalNetPayout += net;
          return acc;
        },
        { totalGross: 0, totalCommission: 0, totalNetPayout: 0 }
      );

      const actor = {
        id: req.user?.id || req.user?._id || null,
        role: req.user?.role || "finance",
        email: req.user?.email || "",
      };

      const batchDoc = {
        status: "processing", // processing -> paid/failed/cancelled
        invoiceIds: oidList,
        invoiceCount: oidList.length,
        totals,
        reference,
        note,

        // ✅ NEW: store payout evidence object (frontend expects this)
        payout: {
          method: null,
          reference: reference || null,
          paidAt: null,
        },

        createdBy: actor,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const ins = await SettlementBatches.insertOne(batchDoc, { session });
      const batchId = ins.insertedId;

      // Lock invoices (race-safe)
      const upd = await Invoices.updateMany(
        {
          _id: { $in: oidList },
          "commissionPayout.status": { $nin: ["processing", "paid"] },
        },
        {
          $set: {
            "commissionPayout.status": "processing",
            "commissionPayout.batchId": batchId,
            "commissionPayout.updatedAt": new Date(),
            ...(note ? { "commissionPayout.note": note } : {}),
          },
        },
        { session }
      );

      if (upd.modifiedCount !== oidList.length) {
        throw new Error("Race condition: some invoices were locked by another batch");
      }

      createdBatch = { _id: batchId, ...batchDoc };

      await auditLog(SettlementAuditLogs, {
        type: "BATCH_CREATED",
        batchId,
        invoiceIds: oidList,
        reference,
        note,
        actor,
      });

      await auditLog(InvoiceAuditLogs, {
        type: "INVOICES_LOCKED_FOR_PAYOUT",
        batchId,
        invoiceIds: oidList,
        actor,
      });
    });

    return res.status(201).json({ batch: createdBatch });
  } catch (err) {
    console.error("create batch error:", err);
    return res.status(400).json({ message: err.message || "Failed to create payout batch" });
  } finally {
    await session.endSession();
  }
});

/* =========================================================
   3) LIST PAYOUT BATCHES
   GET /api/admin/settlements/batches
   Query: page, limit, q, status, sellerId, from, to
========================================================= */
router.get("/settlements/batches", authMiddleware, ensureFinanceAccess, async (req, res) => {
  try {
    const page = parseIntSafe(req.query.page, 1);
    const limit = parseIntSafe(req.query.limit, 20);
    const q = safeString(req.query.q, 200);
    const status = safeString(req.query.status, 30);
    const sellerId = safeString(req.query.sellerId, 80);
    const from = safeString(req.query.from, 30);
    const to = safeString(req.query.to, 30);

    const match = {};
    if (status) match.status = String(status).toLowerCase();

    if (from || to) {
      match.createdAt = {};
      if (from) match.createdAt.$gte = new Date(from);
      if (to) {
        const dt = new Date(to);
        dt.setHours(23, 59, 59, 999);
        match.createdAt.$lte = dt;
      }
    }

    const rx = q ? new RegExp(escapeRegex(q), "i") : null;

    const pipeline = [
      { $match: match },
      ...(rx
        ? [
            {
              $match: {
                $or: [
                  { reference: rx },
                  { note: rx },
                  { status: rx },
                  { "createdBy.email": rx },
                  { "payout.reference": rx }, // ✅ NEW: searchable payout reference
                  { "payout.method": rx }, // ✅ NEW
                ],
              },
            },
          ]
        : []),

      // Optional seller filter by invoice membership
      ...(sellerId
        ? [
            {
              $lookup: {
                from: "invoices",
                localField: "invoiceIds",
                foreignField: "_id",
                as: "_inv",
              },
            },
            { $match: { _inv: { $elemMatch: { sellerId } } } },
          ]
        : []),

      {
        $addFields: {
          totalGross: { $ifNull: ["$totals.totalGross", 0] },
          totalCommission: { $ifNull: ["$totals.totalCommission", 0] },
          totalNetPayout: { $ifNull: ["$totals.totalNetPayout", 0] },
        },
      },

      { $sort: { createdAt: -1 } },
      {
        $facet: {
          items: [
            { $skip: (page - 1) * limit },
            { $limit: limit },
            {
              $project: {
                _id: 1,
                status: 1,
                invoiceCount: 1,
                totals: 1,
                reference: 1,
                note: 1,
                payout: 1, // ✅ NEW: frontend reads batch.payout.*
                createdBy: 1,
                createdAt: 1,
                updatedAt: 1,
                paidAt: 1,
                totalGross: 1,
                totalCommission: 1,
                totalNetPayout: 1,
              },
            },
          ],
          meta: [{ $count: "total" }],
          summary: [
            {
              $group: {
                _id: null,
                totalBatches: { $sum: 1 },
                totalGross: { $sum: "$totalGross" },
                totalCommission: { $sum: "$totalCommission" },
                totalNetPayout: { $sum: "$totalNetPayout" },
              },
            },
          ],
        },
      },
    ];

    const agg = await SettlementBatches.aggregate(pipeline).toArray();
    const out = agg?.[0] || {};
    const items = out.items || [];
    const total = out.meta?.[0]?.total || 0;

    // Recompute totals from invoices to ensure net is accurate (backward compatible)
    const recomputedItems = await Promise.all(
      items.map(async (b) => {
        const idsRaw = Array.isArray(b.invoiceIds) ? b.invoiceIds : [];
        const ids = idsRaw.map((id) => toObjectId(id)).filter(Boolean);
        if (!ids.length) {
          const storedGross = moneyNum(b.totalGross ?? b.totals?.totalGross ?? 0);
          const storedCommission = moneyNum(b.totalCommission ?? b.totals?.totalCommission ?? 0);
          const storedNet = moneyNum(
            b.totalNetPayout ?? b.totals?.totalNetPayout ?? (storedGross - storedCommission)
          );

          return {
            ...b,
            totalGross: storedGross,
            totalCommission: storedCommission,
            totalNetPayout: storedNet,
            totalNet: storedNet,
            invoicesCount: b.invoiceCount ?? idsRaw.length ?? 0,
            sellerCount: 0,
            invoices: [],
          };
        }

        const invs = await Invoices.find({ _id: { $in: ids } })
          .project({
            sellerId: 1,
            sellerName: 1,
            invoiceNumber: 1,
            orderId: 1,
            sellerTotals: 1,
            totals: 1,
            grossTotal: 1,
            commissionTotal: 1,
            netPayout: 1,
            totalAmount: 1,
            payment: 1,
            paymentRef: 1,
            reference: 1,
          })
          .toArray();

        const sellerCount = new Set(invs.map((x) => String(x?.sellerId || ""))).size;

        const totals = invs.reduce(
          (acc, inv) => {
            const gross = moneyNum(
              inv?.sellerTotals?.subtotalBase ??
                inv?.totals?.gross ??
                inv?.grossTotal ??
                inv?.grandTotal ??
                inv?.totalAmount ??
                0
            );
            const commissionRaw =
              inv?.totals?.commission ??
              inv?.commissionTotal ??
              inv?.commissionAmount ??
              null;
            const comm = moneyNum(
              Number.isFinite(commissionRaw)
                ? commissionRaw
                : inv?.sellerTotals
                ? moneyNum(gross - moneyNum(inv?.sellerTotals?.grandTotal ?? gross))
                : 0
            );
            const net = moneyNum(
              inv?.sellerTotals?.grandTotal ??
                inv?.totals?.net ??
                inv?.netPayout ??
                (gross - comm)
            );

            acc.totalGross += gross;
            acc.totalCommission += comm;
            acc.totalNetPayout += net;
            return acc;
          },
          { totalGross: 0, totalCommission: 0, totalNetPayout: 0 }
        );

        const invoicesLite = invs.map((inv) => {
          const gross = moneyNum(
            inv?.sellerTotals?.subtotalBase ??
              inv?.totals?.gross ??
              inv?.grossTotal ??
              inv?.grandTotal ??
              inv?.totalAmount ??
              0
          );
          const commissionRaw =
            inv?.totals?.commission ??
            inv?.commissionTotal ??
            inv?.commissionAmount ??
            null;
          const commission = moneyNum(
            Number.isFinite(commissionRaw)
              ? commissionRaw
              : inv?.sellerTotals
              ? moneyNum(gross - moneyNum(inv?.sellerTotals?.grandTotal ?? gross))
              : 0
          );
          const net = moneyNum(
            inv?.sellerTotals?.grandTotal ??
              inv?.totals?.net ??
              inv?.netPayout ??
              (gross - commission)
          );

          const payRef =
            inv?.payment?.reference ||
            inv?.payment?.ref ||
            inv?.paymentRef ||
            inv?.reference ||
            null;

          return {
            id: inv?._id || inv?.id,
            invoiceNumber: inv?.invoiceNumber,
            orderId: inv?.orderId,
            sellerId: inv?.sellerId,
            sellerName: inv?.sellerName,
            gross,
            commission,
            net,
            paymentReference: payRef,
          };
        });

        return {
          ...b,
          ...totals,
          invoicesCount: ids.length,
          sellerCount,
          invoices: invoicesLite,
        };
      })
    );

    const sum = recomputedItems.reduce(
      (acc, b) => {
        const g = moneyNum(b.totalGross);
        const c = moneyNum(b.totalCommission);
        const n = moneyNum(b.totalNetPayout ?? g - c);

        acc.totalGross += g;
        acc.totalCommission += c;
        acc.totalNetPayout += n;
        return acc;
      },
      { totalGross: 0, totalCommission: 0, totalNetPayout: 0 }
    );

    return res.json({
      items: recomputedItems,
      total,
      page,
      limit,
      summary: {
        totalBatches: Number(out.summary?.[0]?.totalBatches || recomputedItems.length || 0),
        totalGross: moneyNum(sum.totalGross),
        totalCommission: moneyNum(sum.totalCommission),
        totalNetPayout: moneyNum(sum.totalNetPayout),
        totalNet: moneyNum(sum.totalNetPayout),
      },
    });
  } catch (err) {
    console.error("list batches error:", err);
    return res.status(500).json({ message: "Failed to load payout batches" });
  }
});

/* =========================================================
   4) BATCH DETAILS
   GET /api/admin/settlements/batches/:id
   ✅ UPDATED: enrich invoices with seller { storeName, shopName } for frontend + CSV
========================================================= */
router.get("/settlements/batches/:id", authMiddleware, ensureFinanceAccess, async (req, res) => {
  try {
    const batchId = toObjectId(req.params.id);
    if (!batchId) return res.status(400).json({ message: "Invalid batch id" });

    const batch = await SettlementBatches.findOne({ _id: batchId });
    if (!batch) return res.status(404).json({ message: "Batch not found" });

    const invoiceIds = Array.isArray(batch.invoiceIds) ? batch.invoiceIds : [];
    const invoiceOidList = invoiceIds.map((id) => toObjectId(id)).filter(Boolean);

    // If the batch has no invoice ids (old data), fall back to stored totals
    if (!invoiceOidList.length) {
      const storedGross = moneyNum(
        batch.totalGross ?? batch.totals?.totalGross ?? 0
      );
      const storedCommission = moneyNum(
        batch.totalCommission ?? batch.totals?.totalCommission ?? 0
      );
      const storedNet = moneyNum(
        batch.totalNetPayout ??
          batch.totals?.totalNetPayout ??
          (storedGross - storedCommission)
      );

      return res.json({
        ...batch,
        totalGross: storedGross,
        totalCommission: storedCommission,
        totalNetPayout: storedNet,
        invoices: [],
        invoiceCount: batch.invoiceCount ?? 0,
      });
    }

    // Use aggregation so we can attach seller info
    const invoices = await Invoices.aggregate([
      { $match: { _id: { $in: invoiceOidList } } },
      {
        $lookup: {
          from: "users",
          let: { sid: "$sellerId" },
          pipeline: [
            {
              $match: {
                $expr: {
                  $or: [
                    { $eq: [{ $toString: "$_id" }, "$$sid"] },
                    { $eq: ["$sellerId", "$$sid"] },
                  ],
                },
              },
            },
            { $project: { _id: 1, storeName: 1, shopName: 1, email: 1 } },
          ],
          as: "seller",
        },
      },
      { $addFields: { seller: { $first: "$seller" } } },
      {
        $project: {
          _id: 1,
          invoiceNumber: 1,
          orderId: 1,
          orderNumber: 1,
          sellerId: 1,
          sellerName: 1,
          status: 1,
          paymentStatus: 1,
          payment: 1,
          paidAt: 1,
          deliveryStatus: 1,
          orderStatus: 1,
          createdAt: 1,
          totals: 1,
          sellerTotals: 1,
          grossTotal: 1,
          commissionTotal: 1,
          netPayout: 1,
          commissionPayout: 1,
          seller: 1,
        },
      },
    ]).toArray();

    // Normalize amounts per invoice (seller-centric)
    const invoicesWithAmounts = invoices.map((inv) => {
      const gross = moneyNum(
        inv?.sellerTotals?.subtotalBase ??
          inv?.totals?.gross ??
          inv?.grossTotal ??
          inv?.grandTotal ??
          inv?.totalAmount ??
          0
      );
      const netGuess = moneyNum(
        inv?.sellerTotals?.grandTotal ??
          inv?.totals?.net ??
          inv?.netPayout ??
          null
      );
      const commissionRaw =
        inv?.totals?.commission ??
        inv?.commissionTotal ??
        inv?.commissionAmount ??
        null;

      let commission = 0;
      if (Number.isFinite(commissionRaw)) {
        commission = moneyNum(commissionRaw);
      } else if (netGuess) {
        commission = moneyNum(gross - netGuess);
      } else if (inv?.sellerTotals?.grandTotal != null) {
        commission = moneyNum(gross - moneyNum(inv?.sellerTotals?.grandTotal));
      }

      const net = moneyNum(
        netGuess != null ? netGuess : gross - commission
      );
      const returnsTotal = moneyNum(inv?.returnsTotal || inv?.returnDeduction || 0);
      return { ...inv, gross, commission, net, returnsTotal };
    });

    // Recompute totals on the fly from invoices (fallback only)
    const recomputed = invoicesWithAmounts.reduce(
      (acc, inv) => {
        const gross = moneyNum(inv?.gross ?? 0);
        const comm = moneyNum(inv?.commission ?? 0);
        const net = moneyNum(inv?.net ?? gross - comm);
        const ret = moneyNum(inv?.returnsTotal ?? 0);

        acc.totalGross += gross;
        acc.totalCommission += comm;
        acc.totalNetPayout += net;
        acc.totalReturns = (acc.totalReturns || 0) + ret;
        return acc;
      },
      { totalGross: 0, totalCommission: 0, totalNetPayout: 0, totalReturns: 0 }
    );

    // Prefer stored batch totals if they exist; otherwise use recomputed
    const storedTotals = batch.totals || {};
    const hasStoredTotals =
      typeof storedTotals.totalGross === "number" ||
      typeof storedTotals.totalCommission === "number" ||
      typeof storedTotals.totalNetPayout === "number";

    const effective = hasStoredTotals
      ? {
          gross: moneyNum(storedTotals.totalGross),
          commission: moneyNum(storedTotals.totalCommission),
          net: moneyNum(
            storedTotals.totalNetPayout ??
              storedTotals.totalNet ??
              moneyNum(storedTotals.totalGross) - moneyNum(storedTotals.totalCommission)
          ),
          returns: moneyNum(storedTotals.totalReturns ?? recomputed.totalReturns),
        }
      : {
          gross: recomputed.totalGross,
          commission: recomputed.totalCommission,
          net: recomputed.totalNetPayout,
          returns: recomputed.totalReturns,
        };

    return res.json({
      ...batch,

      // Normalise totals in one place
      totals: {
        ...storedTotals,
        // snapshot style
        totalGross: effective.gross,
        totalCommission: effective.commission,
        totalNetPayout: effective.net,
        totalNet: effective.net,
        totalReturns: effective.returns,
        // simple style (if any UI reads these)
        gross: effective.gross,
        commission: effective.commission,
        net: effective.net,
        returns: effective.returns,
      },

      // flat fields (list + details consistency)
      totalGross: effective.gross,
      totalCommission: effective.commission,
      totalNetPayout: effective.net,
      totalNet: effective.net,

      invoices: invoicesWithAmounts,
    });
  } catch (err) {
    console.error("batch details error:", err);
    return res.status(500).json({ message: "Failed to load batch details" });
  }
});

/* =========================================================
   5) UPDATE BATCH STATUS
   PATCH /api/admin/settlements/batches/:id/status
   Body supports:
   - { status, reference?, note? } (legacy)
   - { status, reference?, note?, payout: { method, reference, paidAt } } (frontend)
   ✅ UPDATED:
   - Stores batch.payout evidence
   - Uses provided paidAt if valid
   - When marking PAID: verifies ALL invoices are paid (server-side safety)
========================================================= */
router.patch("/settlements/batches/:id/status", authMiddleware, ensureFinanceAccess, async (req, res) => {
  const session = client.startSession();
  try {
    const batchId = toObjectId(req.params.id);
    if (!batchId) return res.status(400).json({ message: "Invalid batch id" });

    const nextStatus = String(req.body.status || "").toLowerCase();

    // legacy + frontend
    const legacyReference = safeString(req.body.reference, 120);
    const note = safeString(req.body.note, 500);

    // payout object (frontend)
    const payout = req.body?.payout && typeof req.body.payout === "object" ? req.body.payout : null;
    const payoutMethod = normalizePayoutMethod(payout?.method);
    const payoutReference = safeString(payout?.reference, 120) || legacyReference;
    const payoutPaidAt = parsePaidAt(payout?.paidAt);

    if (!["paid", "failed", "cancelled"].includes(nextStatus)) {
      return res.status(400).json({ message: "Invalid status" });
    }

    let updated = null;

    await session.withTransaction(async () => {
      const batch = await SettlementBatches.findOne({ _id: batchId }, { session });
      if (!batch) throw new Error("Batch not found");

      const current = String(batch.status || "").toLowerCase();
      if (current === "paid") throw new Error("Batch is already paid");
      if (current !== "processing") throw new Error("Only PROCESSING batches can be updated");

      if (nextStatus === "paid" && !payoutReference) {
        throw new Error("Reference is required to mark batch as PAID");
      }

      const actor = {
        id: req.user?.id || req.user?._id || null,
        role: req.user?.role || "finance",
        email: req.user?.email || "",
      };

      const invoiceIds = Array.isArray(batch.invoiceIds) ? batch.invoiceIds : [];

      // ✅ Server-side safety: if marking PAID, all invoices must be paid
      if (nextStatus === "paid") {
        const invs = await Invoices.find({ _id: { $in: invoiceIds } }, { session })
          .project({ _id: 1, status: 1, paymentStatus: 1, paidAt: 1, payment: 1 })
          .toArray();

        const unpaid = invs.filter((inv) => !isInvoicePaid(inv));
        if (unpaid.length) {
          const sample = unpaid.slice(0, 5).map((x) => String(x._id)).join(", ");
          throw new Error(`Safety check failed: some invoices are not PAID (${sample})`);
        }
      }

      // consistent paidAt timestamp
      const paidAt = nextStatus === "paid" ? payoutPaidAt || new Date() : null;

      const patch = {
        status: nextStatus,
        updatedAt: new Date(),
        ...(payoutReference ? { reference: payoutReference } : {}),
        ...(note ? { note } : {}),
      };

      if (nextStatus === "paid") {
        patch.paidAt = paidAt;

        // ✅ Store payout evidence object (frontend expects this)
        patch.payout = {
          method: payoutMethod,
          reference: payoutReference,
          paidAt,
          ...(note ? { note } : {}),
        };
      }

      await SettlementBatches.updateOne({ _id: batchId }, { $set: patch }, { session });

      if (nextStatus === "paid") {
        await Invoices.updateMany(
          { _id: { $in: invoiceIds }, "commissionPayout.batchId": batchId },
          {
            $set: {
              "commissionPayout.status": "paid",
              "commissionPayout.paidAt": paidAt,
              "commissionPayout.ref": payoutReference,
              ...(note ? { "commissionPayout.note": note } : {}),
              "commissionPayout.updatedAt": new Date(),
            },
          },
          { session }
        );
      } else {
        // failed/cancelled -> release invoices back to queue
        await Invoices.updateMany(
          { _id: { $in: invoiceIds }, "commissionPayout.batchId": batchId },
          {
            $set: {
              "commissionPayout.status": "pending",
              "commissionPayout.updatedAt": new Date(),
              ...(note ? { "commissionPayout.note": note } : {}),
            },
            $unset: {
              "commissionPayout.batchId": "",
              "commissionPayout.paidAt": "",
              "commissionPayout.ref": "",
            },
          },
          { session }
        );
      }

      await auditLog(SettlementAuditLogs, {
        type: "BATCH_STATUS_UPDATED",
        batchId,
        from: current,
        to: nextStatus,
        reference: payoutReference,
        note,
        payout: nextStatus === "paid" ? { method: payoutMethod, reference: payoutReference, paidAt } : undefined,
        actor,
      });

      updated = await SettlementBatches.findOne({ _id: batchId }, { session });
    });

    return res.json({ batch: updated });
  } catch (err) {
    console.error("update batch status error:", err);
    return res.status(400).json({ message: err.message || "Failed to update batch status" });
  } finally {
    await session.endSession();
  }
});

/* =========================================================
   6) SELLER PAYOUT ACCOUNTS (Finance management)
   GET   /api/admin/settlements/seller-payout-accounts
   PATCH /api/admin/settlements/seller-payout-accounts/:sellerId
========================================================= */
router.get("/settlements/seller-payout-accounts", authMiddleware, ensureFinanceAccess, async (req, res) => {
  try {
    const page = parseIntSafe(req.query.page, 1);
    const limit = parseIntSafe(req.query.limit, 20);
    const q = safeString(req.query.q, 200);

    const match = { role: "seller" };

    if (q) {
      const rx = new RegExp(escapeRegex(q), "i");
      const asOid = toObjectId(q);

      match.$or = [
        { storeName: rx },
        { shopName: rx },
        { email: rx },
        { phone: rx },
        ...(asOid ? [{ _id: asOid }] : []),
      ];
    }

    const pipeline = [
      { $match: match },
      { $sort: { createdAt: -1 } },
      // attach payment settings from seller_settings (by sellerId string)
      {
        $lookup: {
          from: "seller_settings",
          let: { sid: { $toString: "$_id" } },
          pipeline: [
            { $match: { $expr: { $eq: ["$sellerId", "$$sid"] } } },
            { $project: { payment: 1 } },
          ],
          as: "settingsDoc",
        },
      },
      { $unwind: { path: "$settingsDoc", preserveNullAndEmptyArrays: true } },
      {
        $facet: {
          items: [
            { $skip: (page - 1) * limit },
            { $limit: limit },
            {
              $project: {
                _id: 1,
                storeName: 1,
                shopName: 1,
                email: 1,
                phone: 1,
                payout: 1,
                payment: "$settingsDoc.payment",
                payoutHold: 1,
                createdAt: 1,
                updatedAt: 1,
              },
            },
          ],
          meta: [{ $count: "total" }],
        },
      },
    ];

    const agg = await Users.aggregate(pipeline).toArray();
    const out = agg?.[0] || {};
    const items = out.items || [];
    const total = out.meta?.[0]?.total || 0;

    return res.json({ items, total, page, limit });
  } catch (err) {
    console.error("seller payout accounts error:", err);
    return res.status(500).json({ message: "Failed to load seller payout accounts" });
  }
});

router.patch(
  "/settlements/seller-payout-accounts/:sellerId",
  authMiddleware,
  ensureFinanceAccess,
  async (req, res) => {
    try {
      const sellerId = toObjectId(req.params.sellerId);
      if (!sellerId) return res.status(400).json({ message: "Invalid seller id" });

      const payout = req.body.payout || null;
      const payoutHold = typeof req.body.payoutHold === "boolean" ? req.body.payoutHold : undefined;

      const $set = {};
      if (payout) $set.payout = payout;
      if (typeof payoutHold === "boolean") $set.payoutHold = payoutHold;

      if (!Object.keys($set).length) return res.status(400).json({ message: "Nothing to update" });

      $set.updatedAt = new Date();

      const upd = await Users.findOneAndUpdate(
        { _id: sellerId, role: "seller" },
        { $set },
        { returnDocument: "after" }
      );

      if (!upd.value) return res.status(404).json({ message: "Seller not found" });

      await auditLog(SettlementAuditLogs, {
        type: "SELLER_PAYOUT_ACCOUNT_UPDATED",
        sellerId,
        payoutHold: typeof payoutHold === "boolean" ? payoutHold : undefined,
        actor: {
          id: req.user?.id || req.user?._id || null,
          role: req.user?.role || "finance",
          email: req.user?.email || "",
        },
      });

      return res.json({ seller: upd.value });
    } catch (err) {
      console.error("update seller payout account error:", err);
      return res.status(500).json({ message: "Failed to update seller payout account" });
    }
  }
);

/* =========================================================
   7) SETTLEMENT PERIODS & SELLER SETTLEMENTS (finance close)
========================================================= */

router.post("/periods", authMiddleware, ensureFinanceAccess, async (req, res) => {
  try {
    const periodKey = safeString(req.body?.periodKey);
    const startAt = parseDateValue(req.body?.startAt);
    const endAt = parseDateValue(req.body?.endAt);
    if (!periodKey) return res.status(400).json({ message: "periodKey is required" });
    if (!startAt || !endAt || endAt <= startAt)
      return res.status(400).json({ message: "Invalid startAt/endAt range" });

    const nowAt = new Date();
    const periodDoc = {
      periodKey,
      startAt,
      endAt,
      currency: safeString(req.body?.currency) || "NPR",
      status: "draft",
      closedAt: null,
      closedBy: null,
      notes: safeString(req.body?.notes),
      createdAt: nowAt,
      updatedAt: nowAt,
    };

    const insertRes = await SettlementPeriods.insertOne(periodDoc);
    return res.json({ period: { ...periodDoc, _id: insertRes.insertedId } });
  } catch (err) {
    console.error("create settlement period failed:", err);
    if (err?.code === 11000) return res.status(409).json({ message: "Period key already exists" });
    return res.status(400).json({ message: "Failed to create settlement period", error: err.message });
  }
});

router.post("/periods/:periodId/close", authMiddleware, ensureFinanceAccess, async (req, res) => {
  const periodId = toObjectId(req.params.periodId);
  if (!periodId) return res.status(400).json({ message: "Invalid period id" });

  const period = await SettlementPeriods.findOne({ _id: periodId });
  if (!period) return res.status(404).json({ message: "Settlement period not found" });

  const startAt = period.startAt ? new Date(period.startAt) : null;
  const endAt = period.endAt ? new Date(period.endAt) : null;
  if (!startAt || !endAt) return res.status(400).json({ message: "Settlement period missing timeframe" });

  const force = boolish(req.query.force);
  if (period.status === "closed" && !force) {
    return res.status(409).json({ message: "Settlement period already closed. Use force=true to recompute" });
  }

  const actor = { id: String(req.user?.id || req.user?._id || "system"), role: req.user?.role || "finance" };

  await SettlementPeriods.updateOne(
    { _id: periodId },
    { $set: { status: "closing", updatedAt: new Date() } }
  );

  const invoiceRows = await aggregateInvoicesForPeriod({ Invoices, startAt, endAt });
  const ledgerRows = await aggregateLedgerEntriesForPeriod({ LedgerEntries, startAt, endAt });

  const invoiceMap = new Map(invoiceRows.map((row) => [row.sellerId, row]));
  const ledgerMap = new Map(ledgerRows.map((row) => [row.sellerId, row]));
  const sellerIds = new Set([...invoiceMap.keys(), ...ledgerMap.keys()]);

  for (const sellerId of sellerIds) {
    const invoiceRow = invoiceMap.get(sellerId) || {};
    const ledgerRow = ledgerMap.get(sellerId) || {};

    const totals = {
      grossSales: Number(invoiceRow.grossSales || 0),
      platformCommission: Number(invoiceRow.platformCommission || 0),
      refunds: Number(ledgerRow.refundImpact || 0),
      commissionReversals: Number(ledgerRow.commissionReversalImpact || 0),
      codAdjustments: Number(ledgerRow.codAdjustmentImpact || 0),
      payoutAdjustments: Number(ledgerRow.payoutAdjustmentImpact || 0),
      otherAdjustments: Number(ledgerRow.otherImpact || 0),
    };

    const netPayable =
      totals.grossSales -
      totals.platformCommission +
      totals.commissionReversals +
      totals.refunds +
      totals.codAdjustments +
      totals.payoutAdjustments +
      totals.otherAdjustments;

    const counts = {
      invoices: Number(invoiceRow.invoiceCount || 0),
      refunds: Number(ledgerRow.refundCount || 0),
      returns: Array.isArray(ledgerRow.returnIds) ? ledgerRow.returnIds.length : 0,
    };

    const sources = {
      invoiceIds: Array.isArray(invoiceRow.invoiceIds) ? invoiceRow.invoiceIds : [],
      ledgerEntryIds: Array.isArray(ledgerRow.ledgerSampleIds) ? ledgerRow.ledgerSampleIds : [],
    };

    const nowAt = new Date();
    await SellerSettlements.updateOne(
      { periodId: period._id, sellerId },
      {
        $set: {
          currency: period.currency || "NPR",
          totals,
          netPayable,
          sources,
          counts,
          updatedAt: nowAt,
        },
        $setOnInsert: {
          periodId: period._id,
          periodKey: period.periodKey,
          sellerId,
          payout: {
            status: "unpaid",
            method: "bank",
            reference: "",
            paidAt: null,
            paidAmount: 0,
            carryOverAmount: 0,
            notes: "",
          },
          createdAt: nowAt,
          events: [],
        },
        $push: {
          events: {
            at: nowAt,
            actor: { kind: "system", id: actor.id, role: actor.role },
            type: "SETTLEMENT_COMPUTED",
            meta: { periodKey: period.periodKey, netPayable, sellerId },
          },
        },
      },
      { upsert: true }
    );
  }

  const closedAt = new Date();
  await SettlementPeriods.updateOne(
    { _id: period._id },
    {
      $set: {
        status: "closed",
        closedAt,
        closedBy: { userId: actor.id, role: actor.role },
        updatedAt: closedAt,
      },
    }
  );

  return res.json({ ok: true, period: { ...period, status: "closed", closedAt, closedBy: actor }, processed: sellerIds.size });
});

router.get(
  "/periods/:periodId/sellers",
  authMiddleware,
  ensureFinanceAccess,
  async (req, res) => {
    const periodId = toObjectId(req.params.periodId);
    if (!periodId) return res.status(400).json({ message: "Invalid period id" });

    const page = parseIntSafe(req.query.page, 1);
    const limit = parseIntSafe(req.query.limit, 20);
    const skip = (page - 1) * limit;
    const status = safeString(req.query.status);
    const q = safeString(req.query.q);

    const match = { periodId };
    if (status) match["payout.status"] = status;
    if (q) {
      const qMatch = toObjectId(q);
      match.$or = [{ sellerId: q }, ...(qMatch ? [{ sellerId: String(qMatch) }] : [])];
    }

    const pipeline = [
      { $match: match },
      { $sort: { updatedAt: -1, createdAt: -1 } },
      {
        $facet: {
          rows: [{ $skip: skip }, { $limit: limit }],
          total: [{ $count: "count" }],
        },
      },
    ];

    const agg = await SellerSettlements.aggregate(pipeline).toArray();
    const rows = agg?.[0]?.rows || [];
    const total = agg?.[0]?.total?.[0]?.count || 0;
    return res.json({ page, limit, total, rows });
  }
);

router.patch(
  "/:sellerSettlementId/payout",
  authMiddleware,
  ensureFinanceAccess,
  async (req, res) => {
    const settlementId = toObjectId(req.params.sellerSettlementId);
    if (!settlementId) return res.status(400).json({ message: "Invalid seller settlement id" });

    const requestedStatus = safeString(req.body?.status);
    const allowedStatuses = new Set(["queued", "paid", "blocked", "carried_over"]);
    if (!allowedStatuses.has(requestedStatus)) {
      return res.status(400).json({ message: "Invalid payout status" });
    }

    const actor = { id: String(req.user?.id || req.user?._id || "system"), role: req.user?.role || "finance" };
    const session = client.startSession();
    try {
      let payoutPreview = null;
      await session.withTransaction(async () => {
        const settlement = await SellerSettlements.findOne({ _id: settlementId }, { session });
        if (!settlement) throw new Error("SETTLEMENT_NOT_FOUND");

        const netPayable = Number(settlement.netPayable || 0);
        const currentPaid = Number(settlement.payout?.paidAmount || 0);
        const payoutMethod = safeString(req.body?.method || settlement.payout?.method || "bank");
        const reference = safeString(req.body?.reference || settlement.payout?.reference);
        const note = safeString(req.body?.note || settlement.payout?.notes);
        const carryOverAmountInput = Number(req.body?.carryOverAmount ?? req.body?.carryOver ?? 0);

        const updates = {
          "payout.status": requestedStatus,
          "payout.method": payoutMethod,
          updatedAt: new Date(),
        };
        if (reference) updates["payout.reference"] = reference;
        if (note) updates["payout.notes"] = note;

        let ledgerEntryId = null;
        if (requestedStatus === "paid") {
          if (netPayable <= 0) throw new Error("NET_PAYABLE_MUST_BE_POSITIVE");
          const amountRequested = Number(req.body?.amount ?? req.body?.paidAmount ?? 0);
          const remaining = netPayable - currentPaid;
          const payAmount = Number.isFinite(amountRequested) && amountRequested > 0 ? amountRequested : remaining;
          if (payAmount <= 0) throw new Error("NO_AMOUNT_LEFT_TO_PAY");
          if (payAmount > remaining) throw new Error("PAYMENT_EXCEEDS_REMAINING_PAYABLE");

          const paidAt = parsePaidAt(req.body?.paidAt) || new Date();
          const carryOver = Math.max(0, netPayable - (currentPaid + payAmount));

          updates["payout.paidAmount"] = currentPaid + payAmount;
          updates["payout.paidAt"] = paidAt;
          updates["payout.carryOverAmount"] = carryOver;
          updates["payout.reference"] = reference || settlement.payout?.reference || "";

          const ledgerEntry = {
            type: "PAYOUT",
            source: { kind: "settlement", id: settlement._id },
            sellerId: settlement.sellerId,
            currency: settlement.currency,
            debit: 0,
            credit: payAmount,
            sellerImpact: -payAmount,
            meta: {
              periodKey: settlement.periodKey,
              reference: updates["payout.reference"],
              method: payoutMethod,
            },
            status: "posted",
            createdAt: new Date(),
          };
          const ledgerRes = await LedgerEntries.insertOne(ledgerEntry, { session });
          ledgerEntryId = ledgerRes.insertedId;
          payoutPreview = {
            paidAmount: updates["payout.paidAmount"],
            carryOverAmount: carryOver,
            paidAt,
            ledgerEntryId,
          };
        } else if (requestedStatus === "carried_over") {
          const carryOver = Number.isFinite(carryOverAmountInput) && carryOverAmountInput >= 0
            ? carryOverAmountInput
            : Math.max(0, netPayable - currentPaid);
          updates["payout.carryOverAmount"] = carryOver;
          payoutPreview = { carryOverAmount: carryOver };
        }

        await SellerSettlements.updateOne(
          { _id: settlementId },
          {
            $set: updates,
            $push: {
              events: {
                at: new Date(),
                actor: { kind: "finance", id: actor.id, role: actor.role },
                type: "PAYOUT_STATUS_UPDATED",
                meta: {
                  status: requestedStatus,
                  reference: updates["payout.reference"] || null,
                  amount: payoutPreview?.paidAmount || null,
                },
              },
            },
          },
          { session }
        );
      });

      return res.json({ ok: true, payout: payoutPreview });
    } catch (err) {
      console.error("update settlement payout failed:", err);
      if (err?.message === "SETTLEMENT_NOT_FOUND") return res.status(404).json({ message: "Settlement not found" });
      return res.status(400).json({ message: err.message || "Failed to update payout" });
    } finally {
      await session.endSession();
    }
  }
);

router.get(
  "/periods/:periodId/export.csv",
  authMiddleware,
  ensureFinanceAccess,
  async (req, res) => {
    const periodId = toObjectId(req.params.periodId);
    if (!periodId) return res.status(400).json({ message: "Invalid period id" });

    const period = await SettlementPeriods.findOne({ _id: periodId });
    if (!period) return res.status(404).json({ message: "Settlement period not found" });

    const settlements = await SellerSettlements.find({ periodId }).toArray();
    const sellerIds = settlements.map((s) => toObjectId(s.sellerId)).filter(Boolean);
    const sellers = await Users.find({ _id: { $in: sellerIds } }).toArray();
    const sellerLookup = new Map(sellers.map((s) => [String(s._id), s]));

    const header = [
      "sellerId",
      "sellerName",
      "grossSales",
      "commission",
      "refunds",
      "commissionReversals",
      "codAdjustments",
      "netPayable",
      "payoutStatus",
      "payoutReference",
    ];
    const rows = [header];

    for (const settle of settlements) {
      const seller = sellerLookup.get(String(settle.sellerId));
      const sellerName = seller?.storeName || seller?.shopName || seller?.name || "";

      rows.push([
        csvCell(settle.sellerId),
        csvCell(sellerName),
        csvCell(settle.totals?.grossSales ?? 0),
        csvCell(settle.totals?.platformCommission ?? 0),
        csvCell(settle.totals?.refunds ?? 0),
        csvCell(settle.totals?.commissionReversals ?? 0),
        csvCell(settle.totals?.codAdjustments ?? 0),
        csvCell(settle.netPayable ?? 0),
        csvCell(settle.payout?.status || ""),
        csvCell(settle.payout?.reference || ""),
      ]);
    }

    const csvBody = rows.map((row) => row.join(",")).join("\n");
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="settlement-period-${period.periodKey}.csv"`);
    return res.send(csvBody);
  }
);

async function aggregateInvoicesForPeriod({ Invoices, startAt, endAt }) {
  const pipeline = [
    {
      $match: {
        sellerId: { $exists: true, $ne: null },
        $or: [
          { deliveredAt: { $gte: startAt, $lt: endAt } },
          { completedAt: { $gte: startAt, $lt: endAt } },
          { createdAt: { $gte: startAt, $lt: endAt } },
        ],
      },
    },
    {
      $project: {
        sellerId: 1,
        grossSales: {
          $ifNull: [
            "$amounts.subtotal",
            "$amounts.total",
            "$totals.subtotal",
            "$total",
            0,
          ],
        },
        platformCommission: {
          $ifNull: [
            "$commissionSnapshot.amount",
            "$commission.amount",
            0,
          ],
        },
      },
    },
    {
      $group: {
        _id: "$sellerId",
        grossSales: { $sum: "$grossSales" },
        platformCommission: { $sum: "$platformCommission" },
        invoiceIds: { $push: "$_id" },
        invoicesCount: { $sum: 1 },
      },
    },
    {
      $addFields: {
        invoiceIds: { $slice: ["$invoiceIds", 20] },
      },
    },
  ];

  const rows = await Invoices.aggregate(pipeline).toArray();
  return rows.map((row) => ({
    sellerId: String(row._id),
    grossSales: Number(row.grossSales || 0),
    platformCommission: Number(row.platformCommission || 0),
    invoiceCount: Number(row.invoicesCount || 0),
    invoiceIds: Array.isArray(row.invoiceIds) ? row.invoiceIds : [],
  }));
}

async function aggregateLedgerEntriesForPeriod({ LedgerEntries, startAt, endAt }) {
  const pipeline = [
    {
      $match: {
        sellerId: { $exists: true, $ne: null },
        createdAt: { $gte: startAt, $lt: endAt },
      },
    },
    {
      $addFields: {
        sellerImpact: {
          $ifNull: ["$sellerImpact", { $subtract: ["$credit", "$debit"] }],
        },
      },
    },
    {
      $group: {
        _id: "$sellerId",
        refundImpact: {
          $sum: {
            $cond: [{ $eq: ["$type", "REFUND"] }, "$sellerImpact", 0],
          },
        },
        refundCount: {
          $sum: {
            $cond: [{ $eq: ["$type", "REFUND"] }, 1, 0],
          },
        },
        returnIds: {
          $addToSet: {
            $cond: [{ $eq: ["$type", "REFUND"] }, "$source.id", "$$REMOVE"],
          },
        },
        commissionReversalImpact: {
          $sum: {
            $cond: [{ $eq: ["$type", "COMMISSION_REVERSAL"] }, "$sellerImpact", 0],
          },
        },
        codAdjustmentImpact: {
          $sum: {
            $cond: [{ $eq: ["$type", "COD_ADJUSTMENT"] }, "$sellerImpact", 0],
          },
        },
        payoutAdjustmentImpact: {
          $sum: {
            $cond: [{ $eq: ["$type", "SELLER_PAYOUT_ADJUSTMENT"] }, "$sellerImpact", 0],
          },
        },
        otherImpact: {
          $sum: {
            $cond: [
              {
                $or: [
                  { $eq: ["$type", "REFUND"] },
                  { $eq: ["$type", "COMMISSION_REVERSAL"] },
                  { $eq: ["$type", "COD_ADJUSTMENT"] },
                  { $eq: ["$type", "SELLER_PAYOUT_ADJUSTMENT"] },
                ],
              },
              0,
              "$sellerImpact",
            ],
          },
        },
        ledgerCount: { $sum: 1 },
        ledgerSampleIds: { $push: "$_id" },
      },
    },
    {
      $addFields: {
        returnIds: {
          $filter: {
            input: "$returnIds",
            as: "id",
            cond: { $and: [{ $ne: ["$$id", null] }, { $ne: ["$$id", ""] }] },
          },
        },
        ledgerSampleIds: { $slice: ["$ledgerSampleIds", 20] },
      },
    },
  ];

  const rows = await LedgerEntries.aggregate(pipeline).toArray();
  return rows.map((row) => ({
    sellerId: String(row._id),
    refundImpact: Number(row.refundImpact || 0),
    refundCount: Number(row.refundCount || 0),
    returnIds: Array.isArray(row.returnIds) ? row.returnIds.map((id) => String(id)) : [],
    commissionReversalImpact: Number(row.commissionReversalImpact || 0),
    codAdjustmentImpact: Number(row.codAdjustmentImpact || 0),
    payoutAdjustmentImpact: Number(row.payoutAdjustmentImpact || 0),
    otherImpact: Number(row.otherImpact || 0),
    ledgerSampleIds: Array.isArray(row.ledgerSampleIds) ? row.ledgerSampleIds : [],
  }));
}

export default router;
