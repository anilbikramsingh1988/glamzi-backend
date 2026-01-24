// routes/adminInvoicesRoutes.js
import express from "express";
import { ObjectId } from "mongodb";
import PDFDocument from "pdfkit";
import { client } from "../dbConfig.js";
import { authMiddleware } from "../middlewares/authMiddleware.js";

const router = express.Router();

const dbName = process.env.DB_NAME || "glamzi_ecommerce";
const db = client.db(dbName);

const Invoices = db.collection("invoices");
const Users = db.collection("users"); // kept (future enrichment / consistency)
const Orders = db.collection("orders"); // kept (do not remove; other modules may share logic)
const InvoiceAuditLogs = db.collection("invoiceAuditLogs");

// optional: dev log
router.get("/invoices", (req, res, next) => {
  console.log("✅ HIT invoices list route");
  next();
});

/* ======================================================
   HELPERS (HARDENED)
====================================================== */

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

function isValidObjectIdString(v) {
  const s = String(v ?? "").trim();
  return /^[a-fA-F0-9]{24}$/.test(s);
}

function safeString(v, max = 200) {
  if (typeof v !== "string") return "";
  const s = v.trim();
  return s.length > max ? s.slice(0, max) : s;
}

function safeNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function escapeRegex(input = "") {
  return String(input).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function clampInt(v, { min = 1, max = 1000, fallback = 1 } = {}) {
  const n = parseInt(String(v ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function safeDate(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function safeFileName(name, fallback = "invoice") {
  const base = safeString(name, 80) || fallback;
  return base.replace(/[^\w\-]+/g, "_");
}

function buildPeriodRange(period, from, to) {
  const p = safeString(period, 20).toLowerCase();
  const now = new Date();

  if (p === "today") {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    const end = new Date(now);
    end.setHours(23, 59, 59, 999);
    return { start, end };
  }

  if (p === "last7") {
    const start = new Date(now);
    start.setDate(start.getDate() - 7);
    return { start, end: now };
  }

  if (p === "last30") {
    const start = new Date(now);
    start.setDate(start.getDate() - 30);
    return { start, end: now };
  }

  if (p === "custom") {
    const start = safeDate(from);
    const end = safeDate(to);
    if (!start && !end) return null;
    if (end) end.setHours(23, 59, 59, 999);
    return { start: start || null, end: end || null };
  }

  return null;
}

/* ======================================================
   ADMIN / FINANCE GUARD
====================================================== */

function ensureAdminFinance(req, res, next) {
  const role = String(req.user?.role || "").toLowerCase();
  const allowed = ["super-admin", "admin", "account", "finance"];
  if (allowed.includes(role)) return next();
  return res.status(403).json({
    success: false,
    message: "Admin / Finance access only",
  });
}

/* ======================================================
   AUDIT HELPERS
====================================================== */

function makeActor(req) {
  return {
    userId: req.user?._id || req.user?.id || null,
    role: req.user?.role || null,
    email: req.user?.email || null,
    name: req.user?.name || null,
  };
}

async function writeInvoiceAudit({ invoiceId, action, message, meta, req }) {
  try {
    await InvoiceAuditLogs.insertOne({
      invoiceId: invoiceId || null,
      action: String(action || "").toLowerCase(),
      message: message || null,
      meta: meta || null,
      actor: makeActor(req),
      createdAt: new Date(),
    });
  } catch (e) {
    console.warn("Invoice audit log failed:", e?.message || e);
  }
}

/* ======================================================
   MONEY NORMALIZATION
====================================================== */

function normalizeInvoiceMoney(inv) {
  const gross =
    safeNumber(inv?.totals?.gross) ||
    safeNumber(inv?.grossTotal) ||
    safeNumber(inv?.grandTotal) ||
    safeNumber(inv?.totalAmount) ||
    safeNumber(inv?.total) ||
    safeNumber(inv?.amount) ||
    0;

  const commission =
    safeNumber(inv?.commission?.amount) ||
    safeNumber(inv?.commissionAmount) ||
    safeNumber(inv?.commissionTotal) ||
    0;

  const net =
    safeNumber(inv?.totals?.net) ||
    safeNumber(inv?.netPayout) ||
    safeNumber(inv?.sellerNetAmount) ||
    safeNumber(inv?.netAmount) ||
    Math.max(gross - commission, 0);

  return { gross, commission, net };
}

function formatMoneyNPR(n) {
  const v = safeNumber(n, 0);
  return `NPR ${Math.round(v).toLocaleString("en-NP")}`;
}

/* ======================================================
   SAFE PROJECTION (LIST)
====================================================== */

const LIST_PROJECTION = {
  items: 0,
  shippingAddress: 0,
  pdf: 0,
  pdfBuffer: 0,
  html: 0,
  invoiceUrl: 0,
};

/* ======================================================
   1) GET /api/admin/invoices
   - LIST + FILTER + SUMMARY
   ✅ UPDATED:
   - ignores invalid sellerId filter (prevents useless match + avoids 400 patterns)
   - enriches invoices with order-derived effective fields:
     deliveryStatusEffective, paymentStatusEffective, paymentMethodEffective
====================================================== */

router.get("/invoices", authMiddleware, ensureAdminFinance, async (req, res) => {
  try {
    const page = clampInt(req.query.page, { min: 1, fallback: 1 });
    const limit = clampInt(req.query.pageSize || req.query.limit, {
      min: 1,
      max: 100,
      fallback: 10,
    });
    const skip = (page - 1) * limit;

    const status = safeString(req.query.status, 20).toLowerCase();
    const sellerIdRaw = safeString(req.query.sellerId, 64);
    const q = safeString(req.query.q, 80);
    const includeCod = safeString(req.query.includeCod, 10).toLowerCase() === "true";

    // Period support
    const period = safeString(req.query.period, 20);
    const periodRange = buildPeriodRange(period, req.query.from, req.query.to);

    // Backward compatibility: from/to without period
    const fromDate = safeDate(req.query.from);
    const toDateRaw = safeDate(req.query.to);

    const match = {};
    if (status) match.status = status;
    if (!includeCod) match.type = { $nin: ["cod", "cod_snapshot"] };

    // ✅ sellerId is stored as string (ObjectId string). If invalid, ignore (frontend does this too).
    if (sellerIdRaw) {
      if (isValidObjectIdString(sellerIdRaw)) {
        match.sellerId = sellerIdRaw;
      } else {
        // ignore invalid sellerId to prevent confusion / empty results
        // (do not throw; UI already warns and omits param)
      }
    }

    if (periodRange) {
      match.createdAt = {};
      if (periodRange.start) match.createdAt.$gte = periodRange.start;
      if (periodRange.end) match.createdAt.$lte = periodRange.end;
    } else if (fromDate || toDateRaw) {
      match.createdAt = {};
      if (fromDate) match.createdAt.$gte = fromDate;
      if (toDateRaw) {
        toDateRaw.setHours(23, 59, 59, 999);
        match.createdAt.$lte = toDateRaw;
      }
    }

    if (q) {
      const rx = new RegExp(escapeRegex(q), "i");
      match.$or = [
        { invoiceNumber: rx },
        { orderNumber: rx },
        { orderId: rx },
        { customerName: rx },
        { "customer.name": rx },
        { "customer.phone": rx },
        { "customer.email": rx },
      ];
    }

    const pipeline = [
      { $match: match },

      // ✅ seller enrichment
      {
        $addFields: {
          sellerObjId: {
            $convert: {
              input: "$sellerId",
              to: "objectId",
              onError: null,
              onNull: null,
            },
          },
        },
      },
      {
        $lookup: {
          from: "users",
          localField: "sellerObjId",
          foreignField: "_id",
          as: "seller",
        },
      },
      { $addFields: { seller: { $arrayElemAt: ["$seller", 0] } } },

      // ✅ order enrichment (orderId can be string; convert safely)
      {
        $addFields: {
          orderObjId: {
            $convert: {
              input: "$orderId",
              to: "objectId",
              onError: null,
              onNull: null,
            },
          },
        },
      },
      {
        $lookup: {
          from: "orders",
          localField: "orderObjId",
          foreignField: "_id",
          as: "order",
        },
      },
      { $addFields: { order: { $arrayElemAt: ["$order", 0] } } },

      // ✅ effective fields used by Admin InvoiceListing.jsx
      {
        $addFields: {
          deliveryStatusEffective: {
            $ifNull: ["$order.status", "$deliveryStatus"],
          },
          paymentMethodEffective: {
            $ifNull: ["$order.paymentMethod", "$paymentMethod"],
          },
          paymentStatusEffective: {
            $ifNull: ["$order.paymentStatus", "$paymentStatus"],
          },
          paidAtEffective: {
            $ifNull: ["$order.paidAt", "$paidAt"],
          },
        },
      },

      // keep list lightweight
      { $project: { sellerObjId: 0, orderObjId: 0, ...LIST_PROJECTION } },
      { $sort: { createdAt: -1, _id: -1 } },

      {
        $facet: {
          invoices: [{ $skip: skip }, { $limit: limit }],
          meta: [{ $count: "total" }],
          summary: [
            {
              $group: {
                _id: null,
                total: { $sum: 1 },
                totalAmount: {
                  $sum: {
                    $ifNull: [
                      "$totals.gross",
                      {
                        $ifNull: [
                          "$grossTotal",
                          {
                            $ifNull: [
                              "$grandTotal",
                              { $ifNull: ["$totalAmount", { $ifNull: ["$total", 0] }] },
                            ],
                          },
                        ],
                      },
                    ],
                  },
                },
                issued: {
                  $sum: { $cond: [{ $eq: ["$status", "issued"] }, 1, 0] },
                },
                paid: {
                  $sum: { $cond: [{ $eq: ["$status", "paid"] }, 1, 0] },
                },
                pending: {
                  $sum: { $cond: [{ $eq: ["$status", "pending"] }, 1, 0] },
                },
                cancelled: {
                  $sum: { $cond: [{ $eq: ["$status", "cancelled"] }, 1, 0] },
                },
                refunded: {
                  $sum: { $cond: [{ $eq: ["$status", "refunded"] }, 1, 0] },
                },
              },
            },
          ],
        },
      },
      {
        $addFields: {
          total: { $ifNull: [{ $arrayElemAt: ["$meta.total", 0] }, 0] },
          summary: { $ifNull: [{ $arrayElemAt: ["$summary", 0] }, {}] },
        },
      },
      { $project: { meta: 0 } },
    ];

    const [result] = await Invoices.aggregate(pipeline, {
      allowDiskUse: true,
    }).toArray();

    const total = safeNumber(result?.total, 0);

    return res.json({
      success: true,
      invoices: result?.invoices || [],
      pagination: {
        page,
        pageSize: limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
      summary: {
        total: safeNumber(result?.summary?.total),
        issued: safeNumber(result?.summary?.issued),
        paid: safeNumber(result?.summary?.paid),
        pending: safeNumber(result?.summary?.pending),
        cancelled: safeNumber(result?.summary?.cancelled),
        refunded: safeNumber(result?.summary?.refunded),
        totalAmount: safeNumber(result?.summary?.totalAmount),
      },
    });
  } catch (err) {
    console.error("GET /admin/invoices error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

/* ======================================================
   2) GET /api/admin/invoices/:id/pdf
   ✅ UPDATED:
   - also attempts order enrichment for better PDF header fields
====================================================== */

router.get(
  "/invoices/:id/pdf",
  authMiddleware,
  ensureAdminFinance,
  async (req, res) => {
    try {
      const id = toObjectId(req.params.id);
      if (!id)
        return res
          .status(400)
          .json({ success: false, message: "Invalid invoice id" });

      const invoice = await Invoices.findOne({ _id: id });
      if (!invoice)
        return res
          .status(404)
          .json({ success: false, message: "Invoice not found" });

      // best-effort order fetch for effective fields (do not fail PDF if missing)
      let order = null;
      try {
        const orderObjId = toObjectId(invoice?.orderId);
        if (orderObjId) {
          order = await Orders.findOne(
            { _id: orderObjId },
            { projection: { status: 1, paymentStatus: 1, paymentMethod: 1, paidAt: 1 } }
          );
        }
      } catch {
        order = null;
      }

      const mode = safeString(req.query.mode, 20).toLowerCase() || "download";
      const filenameSafe = safeFileName(
        invoice?.invoiceNumber || `invoice-${String(id).slice(-6)}`
      );

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `${mode === "inline" ? "inline" : "attachment"}; filename="invoice-${filenameSafe}.pdf"`
      );

      const doc = new PDFDocument({ size: "A4", margin: 40 });
      doc.pipe(res);

      doc
        .fontSize(18)
        .text(`Invoice ${invoice.invoiceNumber || ""}`.trim() || "Invoice");
      doc.moveDown(0.5);

      doc.fontSize(10).fillColor("#333");
      doc.text(`Invoice ID: ${String(invoice._id)}`);
      doc.text(`Invoice Status: ${String(invoice.status || "-").toUpperCase()}`);

      const deliveryStatusEffective = order?.status || invoice?.deliveryStatus || "-";
      const paymentStatusEffective =
        order?.paymentStatus || invoice?.paymentStatus || (invoice?.status === "paid" ? "paid" : "-");
      const paymentMethodEffective = order?.paymentMethod || invoice?.paymentMethod || "-";
      const paidAtEffective = order?.paidAt || invoice?.paidAt || null;

      doc.text(`Delivery Status: ${String(deliveryStatusEffective || "-").toUpperCase()}`);
      doc.text(`Payment Status: ${String(paymentStatusEffective || "-").toUpperCase()}`);
      doc.text(`Payment Method: ${String(paymentMethodEffective || "-")}`);
      doc.text(
        `Paid At: ${
          paidAtEffective ? new Date(paidAtEffective).toLocaleString() : "-"
        }`
      );

      doc.text(
        `Created: ${
          invoice.createdAt ? new Date(invoice.createdAt).toLocaleString() : "-"
        }`
      );
      doc.moveDown(0.8);

      doc.fontSize(12).text("Seller", { underline: true });
      doc.fontSize(10);
      doc.text(`Seller ID: ${invoice.sellerId || "-"}`);
      doc.text(
        `Seller Name: ${
          invoice.sellerName ||
          invoice?.header?.storeName ||
          invoice?.seller?.storeName ||
          "-"
        }`
      );
      doc.moveDown(0.6);

      doc.fontSize(12).text("Customer", { underline: true });
      doc.fontSize(10);
      doc.text(`Name: ${invoice?.customer?.name || invoice?.customerName || "-"}`);
      doc.text(`Phone: ${invoice?.customer?.phone || "-"}`);
      doc.text(`Email: ${invoice?.customer?.email || "-"}`);
      doc.moveDown(0.6);

      doc.fontSize(12).text("Order", { underline: true });
      doc.fontSize(10);
      doc.text(`Order Number: ${invoice.orderNumber || "-"}`);
      doc.text(`Order ID: ${invoice.orderId || "-"}`);
      doc.moveDown(0.8);

      doc.fontSize(12).text("Items", { underline: true });
      doc.moveDown(0.3);

      const items = Array.isArray(invoice.items) ? invoice.items : [];
      if (!items.length) {
        doc.fontSize(10).text("No items");
      } else {
        doc.fontSize(10);
        items.slice(0, 200).forEach((it, idx) => {
          const qty = safeNumber(it?.quantity, 1);
          const price = safeNumber(it?.price, 0);
          const line = price * qty;
          doc.text(
            `${idx + 1}. ${safeString(it?.title || "Untitled", 120)}  x${qty}  ${formatMoneyNPR(line)}`
          );
        });
        if (items.length > 200) {
          doc.moveDown(0.2);
          doc.text(`(Truncated: showing 200 of ${items.length} items)`);
        }
      }

      doc.moveDown(0.8);
      const m = normalizeInvoiceMoney(invoice);

      doc.fontSize(12).text("Totals", { underline: true });
      doc.fontSize(10);
      doc.text(`Gross: ${formatMoneyNPR(m.gross)}`);
      doc.text(`Commission: ${formatMoneyNPR(m.commission)}`);
      doc.text(`Seller Net: ${formatMoneyNPR(m.net)}`);

      doc.end();

      writeInvoiceAudit({
        invoiceId: id,
        action: "pdf_download",
        message: "Admin generated invoice PDF",
        meta: { mode },
        req,
      }).catch(() => {});
    } catch (err) {
      console.error("GET /admin/invoices/:id/pdf error:", err);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  }
);

/* ======================================================
   3) GET /api/admin/invoices/:id/audit
====================================================== */

router.get(
  "/invoices/:id/audit",
  authMiddleware,
  ensureAdminFinance,
  async (req, res) => {
    try {
      const id = toObjectId(req.params.id);
      if (!id)
        return res
          .status(400)
          .json({ success: false, message: "Invalid invoice id" });

      const page = clampInt(req.query.page, { min: 1, max: 100000, fallback: 1 });
      const limit = clampInt(req.query.limit, { min: 1, max: 100, fallback: 20 });
      const skip = (page - 1) * limit;

      const [logs, total] = await Promise.all([
        InvoiceAuditLogs.find({ invoiceId: id })
          .sort({ createdAt: -1, _id: -1 })
          .skip(skip)
          .limit(limit)
          .toArray(),
        InvoiceAuditLogs.countDocuments({ invoiceId: id }),
      ]);

      return res.json({
        success: true,
        page,
        limit,
        total,
        logs,
      });
    } catch (err) {
      console.error("GET /admin/invoices/:id/audit error:", err);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  }
);

/* ======================================================
   4) GET /api/admin/invoices/:id
   ✅ UPDATED:
   - enriches with seller + order + effective fields (same as list)
====================================================== */

router.get(
  "/invoices/:id",
  authMiddleware,
  ensureAdminFinance,
  async (req, res) => {
    try {
      const id = toObjectId(req.params.id);
      if (!id)
        return res
          .status(400)
          .json({ success: false, message: "Invalid invoice id" });

      const pipeline = [
        { $match: { _id: id } },

        // seller enrichment
        {
          $addFields: {
            sellerObjId: {
              $convert: {
                input: "$sellerId",
                to: "objectId",
                onError: null,
                onNull: null,
              },
            },
          },
        },
        {
          $lookup: {
            from: "users",
            localField: "sellerObjId",
            foreignField: "_id",
            as: "seller",
          },
        },
        { $addFields: { seller: { $arrayElemAt: ["$seller", 0] } } },

        // order enrichment
        {
          $addFields: {
            orderObjId: {
              $convert: {
                input: "$orderId",
                to: "objectId",
                onError: null,
                onNull: null,
              },
            },
          },
        },
        {
          $lookup: {
            from: "orders",
            localField: "orderObjId",
            foreignField: "_id",
            as: "order",
          },
        },
        { $addFields: { order: { $arrayElemAt: ["$order", 0] } } },

        // effective fields for admin UI
        {
          $addFields: {
            deliveryStatusEffective: {
              $ifNull: ["$order.status", "$deliveryStatus"],
            },
            paymentMethodEffective: {
              $ifNull: ["$order.paymentMethod", "$paymentMethod"],
            },
            paymentStatusEffective: {
              $ifNull: ["$order.paymentStatus", "$paymentStatus"],
            },
            paidAtEffective: {
              $ifNull: ["$order.paidAt", "$paidAt"],
            },
          },
        },

        { $project: { sellerObjId: 0, orderObjId: 0 } },
      ];

      const [doc] = await Invoices.aggregate(pipeline).toArray();
      if (!doc)
        return res
          .status(404)
          .json({ success: false, message: "Invoice not found" });

      // Normalize money fields for detail payload
      const moneyNum = (v) => {
        const n = Number(v);
        return Number.isFinite(n) ? n : 0;
      };
      const gross =
        moneyNum(doc?.totals?.gross) ||
        moneyNum(doc?.grossTotal) ||
        moneyNum(doc?.grandTotal) ||
        moneyNum(doc?.totalAmount) ||
        moneyNum(doc?.total);
      const commission =
        moneyNum(doc?.totals?.commission) ||
        moneyNum(doc?.commissionTotal) ||
        moneyNum(doc?.commission?.amount) ||
        moneyNum(doc?.commissionAmount);
      const net =
        moneyNum(doc?.totals?.net) ||
        moneyNum(doc?.netPayout) ||
        Math.max(gross - commission, 0);
      const currency = doc?.totals?.currency || doc?.currency || "NPR";

      doc.totals = {
        ...(doc.totals || {}),
        currency,
        gross,
        commission,
        net,
        grandTotal: gross, // keep grandTotal aligned with gross (customer total)
      };
      doc.grossTotal = gross;
      doc.commissionTotal = commission;
      doc.netPayout = net;
      doc.totalAmount = gross;
      doc.grandTotal = gross;

      return res.json({ success: true, invoice: doc });
    } catch (err) {
      console.error("GET /admin/invoices/:id error:", err);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  }
);

export default router;
