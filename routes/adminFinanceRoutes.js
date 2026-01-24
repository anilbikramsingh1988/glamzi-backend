// routes/adminFinanceRoutes.js (ESM)
//
// Admin Finance Ledger + Statement APIs
// - Ledger list: signed amount (debit negative, credit positive)
// - Statement: opening/closing + rows with delta/running
// - Export: creates job and generates CSV synchronously (xlsx marked as failed for now)
//
// Mount at: /api/admin/finance

import express from "express";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { ObjectId } from "mongodb";
import { getDB } from "../dbConfig.js";

import { authMiddleware, isActiveMiddleware, isStaffMiddleware } from "../middlewares/authMiddleware.js";

// If you already have a finance role guard in your codebase (recommended), import it.
// Otherwise, keep the local ensureFinanceRole below and wire it to your staff roles.
import { ensureFinanceRole as ensureFinanceRoleImported } from "./_financeGuards.js";

const router = express.Router();

/* ----------------------------- small helpers ----------------------------- */

function safeInt(v, def, min, max) {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

function safeNum(v, def = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function pickStr(v) {
  return typeof v === "string" ? v.trim() : "";
}

function isNonEmpty(s) {
  return typeof s === "string" && s.trim() !== "";
}

function escapeRegex(s) {
  return String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toISODateStart(yyyyMmDd) {
  // Treat YYYY-MM-DD as local day boundary; store as UTC start (safe for filters).
  // If you prefer timezone-aware, switch to explicit TZ parsing; for now consistent.
  const s = pickStr(yyyyMmDd);
  if (!s) return null;
  const d = new Date(`${s}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function toISODateEnd(yyyyMmDd) {
  const s = pickStr(yyyyMmDd);
  if (!s) return null;
  const d = new Date(`${s}T23:59:59.999Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseDateRange(from, to) {
  // Accept ISO or YYYY-MM-DD
  const f = pickStr(from);
  const t = pickStr(to);

  const fromDate =
    f.length === 10 ? toISODateStart(f) : f ? new Date(f) : null;
  const toDate =
    t.length === 10 ? toISODateEnd(t) : t ? new Date(t) : null;

  const fromOk = fromDate && !Number.isNaN(fromDate.getTime()) ? fromDate : null;
  const toOk = toDate && !Number.isNaN(toDate.getTime()) ? toDate : null;

  return { from: fromOk, to: toOk };
}

function ensureDirSync(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function makeFileToken() {
  return crypto.randomBytes(8).toString("hex");
}

function json(v) {
  try {
    return JSON.stringify(v);
  } catch {
    return "{}";
  }
}

/* ----------------------------- auth / guards ----------------------------- */

// Prefer your existing finance guard if you have one.
function ensureFinanceRoleLocal(req, res, next) {
  // Adjust this to your staff role model.
  // Common patterns:
  // - req.user.role in ["super-admin","admin","staff"] and req.user.staffRoles includes "finance"
  // - req.user.permissions includes "finance"
  const u = req.user || {};
  const staffRoles = Array.isArray(u.staffRoles) ? u.staffRoles : [];
  const isAdminLike = ["super-admin", "admin", "account"].includes(String(u.role || ""));
  const hasFinanceRole = staffRoles.includes("finance") || staffRoles.includes("Finance");

  if (isAdminLike || hasFinanceRole) return next();
  return res.status(403).json({ message: "Forbidden: finance role required" });
}

const ensureFinanceRole = ensureFinanceRoleImported || ensureFinanceRoleLocal;

/* ----------------------------- collections ----------------------------- */

function getFinanceCollections(db) {
  return {
    Ledger: db.collection("gl_ledger_entries"),
    Jobs: db.collection("gl_report_jobs"),
  };
}

/* ----------------------------- query builders ----------------------------- */

function buildLedgerMatch({ q, accountKey, category, from, to, minAmount, maxAmount }) {
  const match = {};

  if (isNonEmpty(accountKey)) match.accountKey = pickStr(accountKey);
  if (isNonEmpty(category)) match.category = pickStr(category);

  const { from: fromDate, to: toDate } = parseDateRange(from, to);
  if (fromDate || toDate) {
    match.postedAt = {};
    if (fromDate) match.postedAt.$gte = fromDate;
    if (toDate) match.postedAt.$lte = toDate;
  }

  // We store amount as positive + dc. Filtering by signed range needs care.
  // For minimal compatibility, interpret minAmount/maxAmount as ABS amount filter.
  const minAbs = minAmount !== undefined && minAmount !== null && String(minAmount) !== "" ? safeNum(minAmount, null) : null;
  const maxAbs = maxAmount !== undefined && maxAmount !== null && String(maxAmount) !== "" ? safeNum(maxAmount, null) : null;

  if (minAbs != null || maxAbs != null) {
    match.amount = {};
    if (minAbs != null) match.amount.$gte = minAbs;
    if (maxAbs != null) match.amount.$lte = maxAbs;
  }

  const qs = pickStr(q);
  if (qs) {
    const re = new RegExp(escapeRegex(qs), "i");
    match.$or = [
      { accountKey: re },
      { ref: re },
      { sourceRef: re },
      { note: re },
      { category: re },
      { orderNumber: re },
      { invoiceNumber: re },
      { transactionGroupId: re },
      { sellerId: re },
      { sellerName: re },
      { accountName: re },
    ];
  }

  return match;
}

/* ----------------------------- response normalizers ----------------------------- */

function signedAmountFromEntry(e) {
  const amount = safeNum(e?.amount, 0);
  const dc = String(e?.dc || "").toLowerCase();
  // Contract: debit negative, credit positive
  return dc === "debit" ? -Math.abs(amount) : Math.abs(amount);
}

function toLedgerItem(e) {
  return {
    _id: e?._id,
    ref: e?.ref || e?.sourceRef || null,
    type: e?.type || null,
    accountKey: e?.accountKey,
    accountName: e?.accountName || null,
    sellerId: e?.sellerId || null,
    sellerName: e?.sellerName || null,
    orderId: e?.orderId || null,
    orderNumber: e?.orderNumber || null,
    invoiceNumber: e?.invoiceNumber || null,
    amount: signedAmountFromEntry(e),
    date: e?.postedAt ? new Date(e.postedAt).toISOString() : null,
    category: e?.category || null,
    note: e?.note || null,
    // Optional: keep these for later drilldown
    group: e?.transactionGroupId || null,
  };
}

/* ----------------------------- CSV export helpers ----------------------------- */

function csvEscape(value) {
  const s = value == null ? "" : String(value);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function rowsToCsv({ header, rows }) {
  const lines = [];
  lines.push(header.map(csvEscape).join(","));
  for (const r of rows) {
    lines.push(r.map(csvEscape).join(","));
  }
  return lines.join("\n");
}

/* =========================
   Routes
========================= */

// GET /api/admin/finance/ledger
router.get(
  "/ledger",
  authMiddleware,
  isActiveMiddleware,
  isStaffMiddleware,
  ensureFinanceRole,
  async (req, res) => {
    const db = await getDB();
    const { Ledger } = getFinanceCollections(db);

    const page = safeInt(req.query.page, 1, 1, 1000000);
    const limit = safeInt(req.query.limit, 25, 10, 200);
    const skip = (page - 1) * limit;

    const match = buildLedgerMatch({
      q: req.query.q,
      accountKey: req.query.accountKey,
      category: req.query.category,
      from: req.query.from,
      to: req.query.to,
      minAmount: req.query.minAmount,
      maxAmount: req.query.maxAmount,
    });

    // For consistency: postedAt desc
    const sort = { postedAt: -1, _id: -1 };

    const pipeline = [
      { $match: match },
      {
        $facet: {
          items: [
            { $sort: sort },
            { $skip: skip },
            { $limit: limit },
            {
              $project: {
                ref: 1,
                type: 1,
                accountKey: 1,
                accountName: 1,
                sellerId: 1,
                sellerName: 1,
                orderId: 1,
                orderNumber: 1,
                invoiceNumber: 1,
                amount: 1,
                dc: 1,
                postedAt: 1,
                category: 1,
                note: 1,
                sourceRef: 1,
                transactionGroupId: 1,
              },
            },
          ],
          total: [{ $count: "n" }],
          summary: [
            {
              $group: {
                _id: null,
                inflow: {
                  $sum: {
                    $cond: [{ $eq: ["$dc", "credit"] }, "$amount", 0],
                  },
                },
                outflowAbs: {
                  $sum: {
                    $cond: [{ $eq: ["$dc", "debit"] }, "$amount", 0],
                  },
                },
              },
            },
            {
              $project: {
                _id: 0,
                inflow: 1,
                // Contract wants outflow such that net = inflow + outflow.
                // Therefore outflow should be negative.
                outflow: { $multiply: ["$outflowAbs", -1] },
                net: { $subtract: ["$inflow", "$outflowAbs"] },
              },
            },
          ],
        },
      },
    ];

    const agg = await Ledger.aggregate(pipeline, { allowDiskUse: true }).toArray();
    const doc = agg?.[0] || {};

    const itemsRaw = Array.isArray(doc.items) ? doc.items : [];
    const items = itemsRaw.map(toLedgerItem);

    const total = doc.total?.[0]?.n ? Number(doc.total[0].n) : 0;
    const summary = doc.summary?.[0] || { inflow: 0, outflow: 0, net: 0 };

    return res.json({
      items,
      page,
      limit,
      total,
      summary: {
        inflow: safeNum(summary.inflow, 0),
        outflow: safeNum(summary.outflow, 0), // negative
        net: safeNum(summary.net, safeNum(summary.inflow, 0) + safeNum(summary.outflow, 0)),
      },
    });
  }
);

// POST /api/admin/finance/ledger/export
router.post(
  "/ledger/export",
  authMiddleware,
  isActiveMiddleware,
  isStaffMiddleware,
  ensureFinanceRole,
  async (req, res) => {
    const db = await getDB();
    const { Ledger, Jobs } = getFinanceCollections(db);

    const format = pickStr(req.body?.format || "csv").toLowerCase();
    const includeMeta = !!req.body?.includeMeta;
    const query = req.body?.query || {};

    const now = new Date();
    const job = {
      type: "ledger",
      status: "queued",
      format,
      includeMeta,
      querySnapshot: query,
      createdAt: now,
      updatedAt: now,
      createdBy: req.user?._id || null,
      file: null,
      error: null,
    };

    const ins = await Jobs.insertOne(job);
    const jobId = ins.insertedId;

    // XLSX not implemented yet; fail explicitly (frontend already supports)
    if (format === "xlsx") {
      await Jobs.updateOne(
        { _id: jobId },
        { $set: { status: "failed", error: "xlsx export not implemented yet", updatedAt: new Date() } }
      );
      return res.json({ jobId, status: "failed" });
    }

    // Generate CSV synchronously (good enough to start; later move to queue)
    try {
      const match = buildLedgerMatch({
        q: query.q,
        accountKey: query.accountKey,
        category: query.category,
        from: query.from,
        to: query.to,
        minAmount: query.minAmount,
        maxAmount: query.maxAmount,
      });

      const cursor = Ledger.find(match, {
        projection: {
          ref: 1,
          type: 1,
          accountKey: 1,
          accountName: 1,
          sellerId: 1,
          sellerName: 1,
          orderId: 1,
          orderNumber: 1,
          invoiceNumber: 1,
          amount: 1,
          dc: 1,
          postedAt: 1,
          category: 1,
          note: 1,
          sourceRef: 1,
          transactionGroupId: 1,
        },
      }).sort({ postedAt: -1, _id: -1 });

      const rows = [];
      const headerBase = ["date", "accountKey", "dc", "amountSigned", "category", "sourceRef"];
      const headerMeta = ["transactionGroupId", "orderNumber", "invoiceNumber", "sellerId", "sellerName", "note"];
      const header = includeMeta ? headerBase.concat(headerMeta) : headerBase;

      await cursor.forEach((e) => {
        const item = toLedgerItem(e);
        const base = [
          item.date || "",
          item.accountKey || "",
          (e.dc || "").toUpperCase(),
          String(item.amount ?? ""),
          item.category || "",
          item.ref || "",
        ];
        if (!includeMeta) rows.push(base);
        else {
          rows.push(
            base.concat([
              item.group || "",
              item.orderNumber || "",
              item.invoiceNumber || "",
              item.sellerId || "",
              item.sellerName || "",
              item.note || "",
            ])
          );
        }
      });

      const csv = rowsToCsv({ header, rows });

      const reportsDir = path.join(process.cwd(), "uploads", "reports");
      ensureDirSync(reportsDir);

      const filename = `ledger_${String(jobId)}_${makeFileToken()}.csv`;
      const filePath = path.join(reportsDir, filename);
      fs.writeFileSync(filePath, csv, "utf8");

      const file = {
        filename,
        path: `/uploads/reports/${filename}`,
        mimeType: "text/csv",
        size: Buffer.byteLength(csv, "utf8"),
      };

      await Jobs.updateOne(
        { _id: jobId },
        { $set: { status: "done", file, updatedAt: new Date() } }
      );

      return res.json({ jobId, status: "done" });
    } catch (err) {
      await Jobs.updateOne(
        { _id: jobId },
        { $set: { status: "failed", error: String(err?.message || err), updatedAt: new Date() } }
      );
      return res.status(500).json({ jobId, status: "failed" });
    }
  }
);

// GET /api/admin/finance/statement
router.get(
  "/statement",
  authMiddleware,
  isActiveMiddleware,
  isStaffMiddleware,
  ensureFinanceRole,
  async (req, res) => {
    const db = await getDB();
    const { Ledger } = getFinanceCollections(db);

    const accountKey = pickStr(req.query.accountKey);
    if (!accountKey) return res.status(400).json({ message: "accountKey is required" });

    const { from: fromDate, to: toDate } = parseDateRange(req.query.from, req.query.to);

    // Opening balance: all entries before fromDate
    let openingBalance = 0;

    if (fromDate) {
      const openAgg = await Ledger.aggregate([
        { $match: { accountKey, postedAt: { $lt: fromDate } } },
        {
          $group: {
            _id: null,
            credit: { $sum: { $cond: [{ $eq: ["$dc", "credit"] }, "$amount", 0] } },
            debit: { $sum: { $cond: [{ $eq: ["$dc", "debit"] }, "$amount", 0] } },
          },
        },
      ]).toArray();

      const o = openAgg?.[0] || { credit: 0, debit: 0 };
      openingBalance = safeNum(o.credit, 0) - safeNum(o.debit, 0);
    } else {
      // No from date: opening balance = 0 by contract expectation
      openingBalance = 0;
    }

    // Rows within range
    const match = { accountKey };
    if (fromDate || toDate) {
      match.postedAt = {};
      if (fromDate) match.postedAt.$gte = fromDate;
      if (toDate) match.postedAt.$lte = toDate;
    }

    const docs = await Ledger.find(match, {
      projection: {
        postedAt: 1,
        accountKey: 1,
        accountName: 1,
        dc: 1,
        amount: 1,
        category: 1,
        sourceRef: 1,
        transactionGroupId: 1,
        note: 1,
        orderId: 1,
        orderNumber: 1,
        invoiceNumber: 1,
      },
    })
      .sort({ postedAt: 1, _id: 1 })
      .toArray();

    let totalCredit = 0;
    let totalDebit = 0;
    let running = openingBalance;

    const rows = docs.map((d) => {
      const amount = Math.abs(safeNum(d.amount, 0));
      const dc = String(d.dc || "").toLowerCase() === "debit" ? "DEBIT" : "CREDIT";
      const delta = dc === "CREDIT" ? amount : -amount;
      running += delta;

      if (dc === "CREDIT") totalCredit += amount;
      else totalDebit += amount;

      return {
        postedAt: d.postedAt ? new Date(d.postedAt).toISOString() : null,
        accountKey: d.accountKey,
        accountName: d.accountName || null,
        dc,
        amount,
        delta,
        running,
        category: d.category || null,
        source: d.sourceRef || null,
        group: d.transactionGroupId || null,
        note: d.note || null,
        orderId: d.orderId || null,
        orderNumber: d.orderNumber || null,
        invoiceNumber: d.invoiceNumber || null,
      };
    });

    const closingBalance = running;

    return res.json({
      accountKey,
      openingBalance,
      closingBalance,
      summary: {
        totalCredit,
        totalDebit,
        entries: rows.length,
      },
      rows,
    });
  }
);

// POST /api/admin/finance/statement/export
router.post(
  "/statement/export",
  authMiddleware,
  isActiveMiddleware,
  isStaffMiddleware,
  ensureFinanceRole,
  async (req, res) => {
    const db = await getDB();
    const { Ledger, Jobs } = getFinanceCollections(db);

    const format = pickStr(req.body?.format || "csv").toLowerCase();
    const includeMeta = !!req.body?.includeMeta;

    const accountKey = pickStr(req.body?.accountKey);
    const from = req.body?.from;
    const to = req.body?.to;

    if (!accountKey) return res.status(400).json({ message: "accountKey is required" });

    const now = new Date();
    const job = {
      type: "statement",
      status: "queued",
      format,
      includeMeta,
      querySnapshot: { accountKey, from, to },
      createdAt: now,
      updatedAt: now,
      createdBy: req.user?._id || null,
      file: null,
      error: null,
    };

    const ins = await Jobs.insertOne(job);
    const jobId = ins.insertedId;

    if (format === "xlsx") {
      await Jobs.updateOne(
        { _id: jobId },
        { $set: { status: "failed", error: "xlsx export not implemented yet", updatedAt: new Date() } }
      );
      return res.json({ jobId, status: "failed" });
    }

    try {
      const { from: fromDate, to: toDate } = parseDateRange(from, to);

      // Compute opening
      let openingBalance = 0;
      if (fromDate) {
        const openAgg = await Ledger.aggregate([
          { $match: { accountKey, postedAt: { $lt: fromDate } } },
          {
            $group: {
              _id: null,
              credit: { $sum: { $cond: [{ $eq: ["$dc", "credit"] }, "$amount", 0] } },
              debit: { $sum: { $cond: [{ $eq: ["$dc", "debit"] }, "$amount", 0] } },
            },
          },
        ]).toArray();
        const o = openAgg?.[0] || { credit: 0, debit: 0 };
        openingBalance = safeNum(o.credit, 0) - safeNum(o.debit, 0);
      }

      const match = { accountKey };
      if (fromDate || toDate) {
        match.postedAt = {};
        if (fromDate) match.postedAt.$gte = fromDate;
        if (toDate) match.postedAt.$lte = toDate;
      }

      const docs = await Ledger.find(match, {
        projection: {
          postedAt: 1,
          dc: 1,
          amount: 1,
          category: 1,
          sourceRef: 1,
          transactionGroupId: 1,
          note: 1,
          orderNumber: 1,
          invoiceNumber: 1,
        },
      })
        .sort({ postedAt: 1, _id: 1 })
        .toArray();

      let running = openingBalance;

      const headerBase = ["postedAt", "dc", "amount", "delta", "running", "category", "source"];
      const headerMeta = ["group", "orderNumber", "invoiceNumber", "note"];
      const header = includeMeta ? headerBase.concat(headerMeta) : headerBase;

      const rows = docs.map((d) => {
        const amount = Math.abs(safeNum(d.amount, 0));
        const dc = String(d.dc || "").toLowerCase() === "debit" ? "DEBIT" : "CREDIT";
        const delta = dc === "CREDIT" ? amount : -amount;
        running += delta;

        const base = [
          d.postedAt ? new Date(d.postedAt).toISOString() : "",
          dc,
          String(amount),
          String(delta),
          String(running),
          d.category || "",
          d.sourceRef || "",
        ];

        if (!includeMeta) return base;

        return base.concat([
          d.transactionGroupId || "",
          d.orderNumber || "",
          d.invoiceNumber || "",
          d.note || "",
        ]);
      });

      const csv = rowsToCsv({ header, rows });

      const reportsDir = path.join(process.cwd(), "uploads", "reports");
      ensureDirSync(reportsDir);

      const filename = `statement_${String(jobId)}_${makeFileToken()}.csv`;
      const filePath = path.join(reportsDir, filename);
      fs.writeFileSync(filePath, csv, "utf8");

      const file = {
        filename,
        path: `/uploads/reports/${filename}`,
        mimeType: "text/csv",
        size: Buffer.byteLength(csv, "utf8"),
      };

      await Jobs.updateOne(
        { _id: jobId },
        { $set: { status: "done", file, updatedAt: new Date() } }
      );

      return res.json({ jobId, status: "done" });
    } catch (err) {
      await Jobs.updateOne(
        { _id: jobId },
        { $set: { status: "failed", error: String(err?.message || err), updatedAt: new Date() } }
      );
      return res.status(500).json({ jobId, status: "failed" });
    }
  }
);

// GET /api/admin/finance/exports/:jobId
router.get(
  "/exports/:jobId",
  authMiddleware,
  isActiveMiddleware,
  isStaffMiddleware,
  ensureFinanceRole,
  async (req, res) => {
    const db = await getDB();
    const { Jobs } = getFinanceCollections(db);

    const jobId = pickStr(req.params.jobId);
    if (!ObjectId.isValid(jobId)) return res.status(400).json({ message: "Invalid jobId" });

    const job = await Jobs.findOne(
      { _id: new ObjectId(jobId) },
      { projection: { type: 1, status: 1, format: 1, createdAt: 1, updatedAt: 1, file: 1, error: 1 } }
    );

    if (!job) return res.status(404).json({ message: "Job not found" });

    return res.json({
      jobId: job._id,
      status: job.status,
      type: job.type,
      format: job.format,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      downloadUrl: job.file?.path || null,
      error: job.error || null,
    });
  }
);

// GET /api/admin/finance/exports/:jobId/download
router.get(
  "/exports/:jobId/download",
  authMiddleware,
  isActiveMiddleware,
  isStaffMiddleware,
  ensureFinanceRole,
  async (req, res) => {
    const db = await getDB();
    const { Jobs } = getFinanceCollections(db);

    const jobId = pickStr(req.params.jobId);
    if (!ObjectId.isValid(jobId)) return res.status(400).json({ message: "Invalid jobId" });

    const job = await Jobs.findOne(
      { _id: new ObjectId(jobId) },
      { projection: { status: 1, file: 1 } }
    );

    if (!job) return res.status(404).json({ message: "Job not found" });
    if (job.status !== "done" || !job.file?.filename) {
      return res.status(409).json({ message: "Job not ready" });
    }

    const abs = path.join(process.cwd(), "uploads", "reports", job.file.filename);
    if (!fs.existsSync(abs)) return res.status(404).json({ message: "File missing" });

    res.setHeader("Content-Type", job.file.mimeType || "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="${job.file.filename}"`);
    return fs.createReadStream(abs).pipe(res);
  }
);

// GET /api/admin/finance/settlements/runs
router.get(
  "/settlements/runs",
  authMiddleware,
  isActiveMiddleware,
  isStaffMiddleware,
  ensureFinanceRole,
  async (req, res) => {
    const db = await getDB();
    const limit = clampInt(req.query.limit, { min: 1, max: 200, fallback: 50 });

    const runs = await db
      .collection("gl_settlement_runs")
      .find(
        {},
        {
          projection: {
            businessDate: 1,
            status: 1,
            steps: 1,
            runId: 1,
            closeId: 1,
            startedAt: 1,
            finishedAt: 1,
            updatedAt: 1,
            createdAt: 1,
          },
        }
      )
      .sort({ businessDate: -1, _id: -1 })
      .limit(limit)
      .toArray();

    return res.json({ runs, limit });
  }
);

export default router;
