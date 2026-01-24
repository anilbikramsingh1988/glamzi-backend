// routes/adminCommissionRoutes.js
import express from "express";
import dotenv from "dotenv";
import { ObjectId } from "mongodb";
import { client } from "../dbConfig.js";
import { authMiddleware, isActiveMiddleware } from "../middlewares/authMiddleware.js";

dotenv.config();

const router = express.Router();

const dbName = process.env.DB_NAME || "glamzi_ecommerce";
const db = client.db(dbName);

const Invoices = db.collection("invoices");
const Users = db.collection("users");
const CommissionSettings = db.collection("commissionSettings");
const Settlements = db.collection("settlements");
const Orders = db.collection("orders");

// ✅ IMPORTANT FIX:
// Do NOT use isStaffMiddleware here (it often blocks admin/account).
// We enforce finance roles using ensureFinanceRole() below.
const financeGuard = [authMiddleware, isActiveMiddleware];

// Only allow these staff roles for finance module
function ensureFinanceRole(req, res) {
  const role = String(req.user?.role || "").toLowerCase();
  const allowed = ["super-admin", "admin", "account"];
  if (!allowed.includes(role)) {
    res.status(403).json({ success: false, message: "Finance access only" });
    return false;
  }
  return true;
}

/* ===============================
   Helpers
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

function safeDate(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseDateStart(v) {
  const d = safeDate(v);
  if (!d) return null;
  d.setHours(0, 0, 0, 0);
  return d;
}

function parseDateEnd(v) {
  const d = safeDate(v);
  if (!d) return null;
  d.setHours(23, 59, 59, 999);
  return d;
}

function toInt(v, def) {
  const n = parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) ? n : def;
}

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function clampNumber(n, min, max) {
  const x = Number(n);
  if (!Number.isFinite(x)) return min;
  return Math.min(max, Math.max(min, x));
}

// ✅ robust boolean normalization
function safeBool(v) {
  if (typeof v === "boolean") return v;
  const s = String(v ?? "").trim().toLowerCase();
  if (["true", "1", "yes", "y", "on"].includes(s)) return true;
  if (["false", "0", "no", "n", "off", ""].includes(s)) return false;
  return false;
}

/* ===============================
   Settings normalization
=============================== */

const DEFAULT_SETTINGS = {
  global: {
    rateType: "percentage", // "percentage" | "flat"
    rate: 10,
    minRate: 0,
    maxRate: 40,
    applyOn: "product-price", // "product-price" | "product-price-with-tax" | "subtotal-with-shipping"
  },
  payout: {
    cycle: "monthly", // "weekly" | "monthly" | "manual"
    payoutDayOfWeek: "monday",
    payoutDayOfMonth: 5,
    minPayoutAmount: 1000,
    autoPayout: false,
    holdDays: 7,
  },
  rules: {
    applyOnShipping: false,
    includeTaxInCommission: false,
    allowCustomPerSeller: true,
    allowCategoryOverrides: true,
  },
  categoryRules: [],
  sellerOverrides: [],
};

function normalizeSettings(input = {}) {
  const s = input && typeof input === "object" ? input : {};

  const global = s.global && typeof s.global === "object" ? s.global : {};
  const payout = s.payout && typeof s.payout === "object" ? s.payout : {};
  const rules = s.rules && typeof s.rules === "object" ? s.rules : {};

  const rateType = ["percentage", "flat"].includes(global.rateType)
    ? global.rateType
    : DEFAULT_SETTINGS.global.rateType;

  const applyOn = [
    "product-price",
    "product-price-with-tax",
    "subtotal-with-shipping",
  ].includes(global.applyOn)
    ? global.applyOn
    : DEFAULT_SETTINGS.global.applyOn;

  const normalized = {
    global: {
      rateType,
      rate: clampNumber(
        global.rate ?? DEFAULT_SETTINGS.global.rate,
        0,
        999999999
      ),
      minRate: clampNumber(
        global.minRate ?? DEFAULT_SETTINGS.global.minRate,
        0,
        100
      ),
      maxRate: clampNumber(
        global.maxRate ?? DEFAULT_SETTINGS.global.maxRate,
        0,
        100
      ),
      applyOn,
    },
    payout: {
      cycle: ["weekly", "monthly", "manual"].includes(payout.cycle)
        ? payout.cycle
        : DEFAULT_SETTINGS.payout.cycle,
      payoutDayOfWeek: [
        "monday",
        "tuesday",
        "wednesday",
        "thursday",
        "friday",
        "saturday",
        "sunday",
      ].includes(payout.payoutDayOfWeek)
        ? payout.payoutDayOfWeek
        : DEFAULT_SETTINGS.payout.payoutDayOfWeek,
      payoutDayOfMonth: clampNumber(
        payout.payoutDayOfMonth ?? DEFAULT_SETTINGS.payout.payoutDayOfMonth,
        1,
        28
      ),
      minPayoutAmount: clampNumber(
        payout.minPayoutAmount ?? DEFAULT_SETTINGS.payout.minPayoutAmount,
        0,
        999999999
      ),
      autoPayout: safeBool(payout.autoPayout),
      holdDays: clampNumber(
        payout.holdDays ?? DEFAULT_SETTINGS.payout.holdDays,
        0,
        365
      ),
    },
    rules: {
      applyOnShipping: safeBool(rules.applyOnShipping),
      includeTaxInCommission: safeBool(rules.includeTaxInCommission),
      allowCustomPerSeller: safeBool(rules.allowCustomPerSeller),
      allowCategoryOverrides: safeBool(rules.allowCategoryOverrides),
    },
    categoryRules: Array.isArray(s.categoryRules) ? s.categoryRules : [],
    sellerOverrides: Array.isArray(s.sellerOverrides) ? s.sellerOverrides : [],
  };

  if (normalized.global.minRate > normalized.global.maxRate) {
    const tmp = normalized.global.minRate;
    normalized.global.minRate = normalized.global.maxRate;
    normalized.global.maxRate = tmp;
  }

  return normalized;
}

/**
 * ✅ Updated: exact safe version you asked to remember
 * Returns: { rateType: "percentage"|"flat", rate: number }
 */
async function getDefaultCommissionRate() {
  const doc = await CommissionSettings.findOne(
    { _id: "default" },
    { projection: { "settings.global.rateType": 1, "settings.global.rate": 1 } }
  );

  const rateTypeRaw = doc?.settings?.global?.rateType;
  const rateRaw = doc?.settings?.global?.rate;

  const rateType = String(rateTypeRaw || "percentage").toLowerCase();
  const rate = Number(rateRaw);

  if (!Number.isFinite(rate) || rate < 0)
    return { rateType: "percentage", rate: 0 };
  return { rateType: rateType === "flat" ? "flat" : "percentage", rate };
}

/* ======================================================
   DEBUG: Test commission listing without auth
====================================================== */
router.get("/commission/test-listing", async (req, res) => {
  try {
    const { rateType: defaultRateType, rate: defaultRate } = await getDefaultCommissionRate();
    const match = {};
    const skip = 0;
    const limitNum = 20;
    
    // Direct test
    const directCount = await Invoices.countDocuments({});
    console.log("[TEST] Direct count:", directCount);
    
    // Simple aggregation test
    const simple = await Invoices.aggregate([{ $match: {} }, { $limit: 2 }]).toArray();
    console.log("[TEST] Simple agg:", simple.length);
    
    // Test the exact pipeline from listing
    const pipeline = [
      { $match: match },
      {
        $addFields: {
          sellerObjId: { $convert: { input: "$sellerId", to: "objectId", onError: null, onNull: null } },
          _gross: {
            $convert: {
              input: {
                $ifNull: [
                  "$sellerTotals.grandTotal",
                  {
                    $ifNull: [
                "$sellerTotals.grandTotal",
                {
                  $ifNull: [
                    "$totals.grandTotal",
                    { $ifNull: ["$grandTotal", { $ifNull: ["$totalAmount", 0] }] },
                  ],
                },
              ],
            },
                ],
              },
              to: "double",
              onError: 0,
              onNull: 0,
            },
          },
        },
      },
      { $lookup: { from: "users", localField: "sellerObjId", foreignField: "_id", as: "seller" } },
      { $unwind: { path: "$seller", preserveNullAndEmptyArrays: true } },
      {
        $addFields: {
          payoutStatus: { $toLower: { $ifNull: ["$commissionPayout.status", "pending"] } },
          _rateType: { $toLower: { $ifNull: ["$commission.rateType", defaultRateType] } },
          _rate: { $ifNull: ["$commission.rate", defaultRate] },
          _commission: { $convert: { input: { $ifNull: ["$commission.amount", { $round: [{ $divide: [{ $multiply: ["$_gross", { $ifNull: ["$commission.rate", defaultRate] }] }, 100] }, 2] }] }, to: "double", onError: 0, onNull: 0 } },
          sellerName: { $ifNull: ["$seller.storeName", { $ifNull: ["$seller.shopName", "$seller.email"] }] },
        },
      },
      { $addFields: { _net: { $max: [{ $subtract: ["$_gross", "$_commission"] }, 0] } } },
      { $sort: { createdAt: -1 } },
      {
        $facet: {
          rows: [{ $skip: skip }, { $limit: limitNum }, { $project: { _id: 1, sellerId: 1, sellerName: 1, grossTotal: "$_gross", commissionTotal: "$_commission" } }],
          meta: [{ $count: "total" }],
        },
      },
    ];
    
    const out = await Invoices.aggregate(pipeline, { allowDiskUse: true }).toArray();
    console.log("[TEST] Pipeline result:", JSON.stringify(out).substring(0, 500));
    
    return res.json({
      success: true,
      directCount,
      simpleCount: simple.length,
      rowCount: out?.[0]?.rows?.length || 0,
      total: out?.[0]?.meta?.[0]?.total || 0,
      firstRow: out?.[0]?.rows?.[0] || null
    });
  } catch (err) {
    console.error("[TEST] Error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

/* ======================================================
   GET/PUT /api/admin/commission/settings
   Mounted at: app.use("/api/admin", adminCommissionRoutes)
   => GET/PUT /api/admin/commission/settings
====================================================== */

router.get("/commission/settings", financeGuard, async (req, res) => {
  try {
    if (!ensureFinanceRole(req, res)) return;

    const doc = await CommissionSettings.findOne({ _id: "default" });

    return res.json({
      success: true,
      settings: doc?.settings || null,
      updatedAt: doc?.updatedAt || null,
      updatedBy: doc?.updatedBy || null,
    });
  } catch (err) {
    console.error("admin commission settings get error:", err);
    return res
      .status(500)
      .json({ success: false, message: "Failed to load commission settings" });
  }
});

router.put("/commission/settings", financeGuard, async (req, res) => {
  try {
    if (!ensureFinanceRole(req, res)) return;

    const incoming = req.body?.settings;
    const normalized = normalizeSettings(incoming);

    await CommissionSettings.updateOne(
      { _id: "default" },
      {
        $set: {
          settings: normalized,
          updatedAt: new Date(),
          updatedBy: req.user?._id || req.user?.id || req.user?.email || null,
        },
      },
      { upsert: true }
    );

    return res.json({ success: true });
  } catch (err) {
    console.error("admin commission settings save error:", err);
    return res
      .status(500)
      .json({ success: false, message: "Failed to save commission settings" });
  }
});

/* ======================================================
   GET /api/admin/commission/listing
   ✅ FIXES:
   - Works with frontend params: q, status, from, to, page, limit
   - Still supports legacy params: search, invoiceStatus, payoutStatus, min, max
   - Supports payoutStatus: pending|processing|paid|failed|cancelled
   - Uses flat/percentage commission logic (default + per-invoice snapshot)
   - Response includes items/invoices/commissions aliases (UI compatibility)
====================================================== */

const ALLOWED_INVOICE_STATUS = [
  "draft",
  "issued",
  "pending",
  "paid",
  "cancelled",
  "refunded",
];

const ALLOWED_PAYOUT_STATUS = [
  "pending",
  "processing",
  "paid",
  "failed",
  "cancelled",
];

router.get("/commission/listing", financeGuard, async (req, res) => {
  console.log("[Commission Listing] Called, user:", req.user?.email, "role:", req.user?.role);
  try {
    if (!ensureFinanceRole(req, res)) return;

    const {
      q = "",
      status = "",
      search = "",
      invoiceStatus = "",
      payoutStatus = "",
      from = "",
      to = "",
      min = "",
      max = "",
      page = "1",
      limit = "20",
      sellerId = "",
    } = req.query;

    const pageNum = Math.max(1, toInt(page, 1));
    const limitNum = Math.min(100, Math.max(10, toInt(limit, 20)));
    const skip = (pageNum - 1) * limitNum;

    const start = parseDateStart(from);
    const end = parseDateEnd(to);

    const { rateType: defaultRateType, rate: defaultRate } = await getDefaultCommissionRate();

    // Build match conditions
    const match = {};
    const sid = String(sellerId || "").trim();
    if (sid) {
      const sidObj = toObjectId(sid);
      match.$or = [{ sellerId: sid }, ...(sidObj ? [{ sellerId: sidObj }] : [])];
    }
    if (start || end) {
      match.createdAt = {};
      if (start) match.createdAt.$gte = start;
      if (end) match.createdAt.$lte = end;
    }

    // WORKING PIPELINE (proven to work in test-listing endpoint)
    const pipeline = [
      { $match: match },
      {
        $addFields: {
          sellerObjId: { $convert: { input: "$sellerId", to: "objectId", onError: null, onNull: null } },
          _gross: {
            $convert: {
              input: {
                $ifNull: [
                  "$sellerTotals.grandTotal",
                  {
                    $ifNull: [
                      "$totals.grandTotal",
                      { $ifNull: ["$grandTotal", { $ifNull: ["$totalAmount", 0] }] },
                    ],
                  },
                ],
              },
              to: "double",
              onError: 0,
              onNull: 0,
            },
          },
        },
      },
      { $lookup: { from: "users", localField: "sellerObjId", foreignField: "_id", as: "seller" } },
      { $unwind: { path: "$seller", preserveNullAndEmptyArrays: true } },
      {
        $addFields: {
          sellerName: { $ifNull: ["$seller.storeName", { $ifNull: ["$seller.shopName", { $ifNull: ["$seller.fullName", "$seller.email"] }] }] },
          sellerEmail: "$seller.email",
          _commission: { $round: [{ $divide: [{ $multiply: ["$_gross", defaultRate] }, 100] }, 2] },
          payoutStatus: { $toLower: { $ifNull: ["$commissionPayout.status", "pending"] } },
        },
      },
      { $addFields: { _net: { $subtract: ["$_gross", "$_commission"] } } },
      { $sort: { createdAt: -1 } },
      {
        $facet: {
          rows: [
            { $skip: skip },
            { $limit: limitNum },
            {
              $project: {
                _id: 1,
                createdAt: 1,
                invoiceStatus: "$status",
                payoutStatus: 1,
                sellerId: 1,
                sellerName: 1,
                sellerEmail: 1,
                orderId: 1,
                invoiceNumber: 1,
                grossTotal: "$_gross",
                commissionTotal: "$_commission",
                netPayout: "$_net",
                orderTotal: "$_gross",
                rateType: defaultRateType,
                rate: defaultRate,
                amount: "$_commission",
              },
            },
          ],
          meta: [{ $count: "total" }],
          summary: [
            {
              $group: {
                _id: null,
                totalGross: { $sum: "$_gross" },
                totalCommission: { $sum: "$_commission" },
                totalNet: { $sum: "$_net" },
                totalInvoices: { $sum: 1 },
                payoutPendingAmount: { $sum: { $cond: [{ $eq: ["$payoutStatus", "pending"] }, "$_commission", 0] } },
                payoutPaidAmount: { $sum: { $cond: [{ $eq: ["$payoutStatus", "paid"] }, "$_commission", 0] } },
              },
            },
            { $project: { _id: 0 } },
          ],
        },
      },
    ];

    console.log("[Commission Listing] Running pipeline with match:", JSON.stringify(match));
    const out = await Invoices.aggregate(pipeline, { allowDiskUse: true }).toArray();
    console.log("[Commission Listing] Result - rows:", out?.[0]?.rows?.length, "total:", out?.[0]?.meta?.[0]?.total);
    
    const result = out?.[0] || {};
    let rows = result.rows || [];
    let total = result.meta?.[0]?.total || 0;
    let summary = result.summary?.[0] || null;

    // ✅ FALLBACK: If no invoices, compute commissions from orders directly
    // Orders structure: items[].sellerId, totals.grandTotal
    if (rows.length === 0) {
      const orderMatch = {};
      if (start || end) {
        orderMatch.createdAt = {};
        if (start) orderMatch.createdAt.$gte = start;
        if (end) orderMatch.createdAt.$lte = end;
      }
      // Only include paid/completed orders for commission
      orderMatch.paymentStatus = { $in: ["paid", "completed", "success"] };

      // Apply status filter (maps to order status)
      if (legacyStatus) {
        orderMatch.status = legacyStatus;
      }

      // Pipeline: unwind items to get per-seller commission rows
      const orderPipeline = [
        { $match: orderMatch },
        // Unwind items to get individual seller entries
        { $unwind: { path: "$items", preserveNullAndEmptyArrays: false } },
        // Add computed fields
        {
          $addFields: {
            // Get sellerId from item
            itemSellerId: { $ifNull: ["$items.sellerId", null] },
            sellerObjId: {
              $convert: {
                input: { $ifNull: ["$items.sellerId", null] },
                to: "objectId",
                onError: null,
                onNull: null,
              },
            },
            // Convert IDs to strings for search
            orderIdStr: { $toString: "$_id" },
            sellerIdStr: { $toString: { $ifNull: ["$items.sellerId", ""] } },
            // Calculate item total (price * quantity)
            _itemTotal: {
              $multiply: [
                { $ifNull: ["$items.price", 0] },
                { $ifNull: ["$items.quantity", 1] },
              ],
            },
          },
        },
        // Apply sellerId filter if provided (on item.sellerId)
        ...(sellerId
          ? [
              {
                $match: {
                  $or: [
                    { itemSellerId: sellerId },
                    { sellerObjId: toObjectId(sellerId) },
                  ].filter(Boolean),
                },
              },
            ]
          : []),
        // Group by order + seller to get per-seller totals
        {
          $group: {
            _id: { orderId: "$_id", sellerId: "$itemSellerId" },
            orderId: { $first: "$_id" },
            orderNumber: { $first: "$orderNumber" },
            createdAt: { $first: "$createdAt" },
            orderStatus: { $first: "$status" },
            sellerId: { $first: "$itemSellerId" },
            sellerObjId: { $first: "$sellerObjId" },
            orderIdStr: { $first: "$orderIdStr" },
            sellerIdStr: { $first: "$sellerIdStr" },
            _gross: { $sum: "$_itemTotal" },
          },
        },
        // Lookup seller info
        {
          $lookup: {
            from: "users",
            localField: "sellerObjId",
            foreignField: "_id",
            as: "seller",
          },
        },
        { $unwind: { path: "$seller", preserveNullAndEmptyArrays: true } },
        // Calculate commission and seller info
        {
          $addFields: {
            _commission: {
              $round: [
                {
                  $cond: [
                    { $eq: [defaultRateType, "flat"] },
                    defaultRate,
                    { $divide: [{ $multiply: ["$_gross", defaultRate] }, 100] },
                  ],
                },
                2,
              ],
            },
            sellerName: {
              $ifNull: [
                "$seller.storeName",
                { $ifNull: ["$seller.shopName", { $ifNull: ["$seller.name", "$seller.email"] }] },
              ],
            },
            sellerEmail: "$seller.email",
          },
        },
        {
          $addFields: {
            _net: { $max: [{ $subtract: ["$_gross", "$_commission"] }, 0] },
          },
        },
        // Apply search on string fields only (not ObjectId)
        ...(qRegex
          ? [
              {
                $match: {
                  $or: [
                    { orderIdStr: qRegex },
                    { sellerIdStr: qRegex },
                    { orderNumber: qRegex },
                    { sellerName: qRegex },
                    { sellerEmail: qRegex },
                  ],
                },
              },
            ]
          : []),
        // Apply amount filters
        ...((minAmt !== null || maxAmt !== null)
          ? [
              {
                $match: {
                  _commission: {
                    ...(minAmt !== null ? { $gte: minAmt } : {}),
                    ...(maxAmt !== null ? { $lte: maxAmt } : {}),
                  },
                },
              },
            ]
          : []),
        { $sort: { createdAt: -1 } },
        {
          $facet: {
            rows: [
              { $skip: skip },
              { $limit: limitNum },
              {
                $project: {
                  _id: 1,
                  createdAt: 1,
                  invoiceStatus: { $ifNull: ["$status", "pending"] },
                  payoutStatus: "pending",
                  sellerId: 1,
                  sellerName: 1,
                  sellerEmail: 1,
                  orderId: "$_id",
                  invoiceNumber: { $ifNull: ["$orderNumber", { $toString: "$_id" }] },
                  grossTotal: "$_gross",
                  commissionTotal: "$_commission",
                  netPayout: "$_net",
                  orderTotal: "$_gross",
                  rateType: defaultRateType,
                  rate: defaultRate,
                  amount: "$_commission",
                },
              },
            ],
            meta: [{ $count: "total" }],
            summary: [
              {
                $group: {
                  _id: null,
                  totalGross: { $sum: "$_gross" },
                  totalCommission: { $sum: "$_commission" },
                  totalNet: { $sum: "$_net" },
                  totalInvoices: { $sum: 1 },
                  payoutPaidAmount: { $sum: 0 },
                  payoutProcessingAmount: { $sum: 0 },
                  payoutPendingAmount: { $sum: "$_commission" },
                  payoutFailedAmount: { $sum: 0 },
                },
              },
              { $project: { _id: 0 } },
            ],
          },
        },
      ];

      const orderOut = await Orders.aggregate(orderPipeline, { allowDiskUse: true }).toArray();
      const orderResult = orderOut?.[0] || {};
      rows = orderResult.rows || [];
      total = orderResult.meta?.[0]?.total || 0;
      summary = orderResult.summary?.[0] || null;
    }

    const totalPages = Math.max(1, Math.ceil(total / limitNum));
    const finalSummary = summary || {
      totalGross: 0,
      totalCommission: 0,
      totalNet: 0,
      totalInvoices: 0,
      payoutPaidAmount: 0,
      payoutProcessingAmount: 0,
      payoutPendingAmount: 0,
      payoutFailedAmount: 0,
    };

    return res.json({
      success: true,

      // ✅ critical: your CommissionReport.jsx reads data.items or data.invoices
      items: rows,
      invoices: rows,
      commissions: rows,

      summary: finalSummary,

      page: pageNum,
      limit: limitNum,
      total,
      totalPages,
      pagination: { page: pageNum, pages: totalPages, total },
    });
  } catch (err) {
    console.error("admin commission listing error:", err);
    return res
      .status(500)
      .json({ success: false, message: "Failed to fetch commission listing" });
  }
});

/* ======================================================
   ✅ GET /api/admin/commission/unsettled
   Used by CommissionUnsettled.jsx:
   - returns: invoices[], total, summary
   Query: page, limit, sellerId, q, dateFrom, dateTo
====================================================== */

router.get("/commission/unsettled", financeGuard, async (req, res) => {
  try {
    if (!ensureFinanceRole(req, res)) return;

    const {
      page = "1",
      limit = "20",
      sellerId = "",
      q = "",
      dateFrom = "",
      dateTo = "",
    } = req.query;

    const pageNum = Math.max(1, toInt(page, 1));
    const limitNum = Math.min(100, Math.max(1, toInt(limit, 20)));
    const skip = (pageNum - 1) * limitNum;

    const sid = String(sellerId || "").trim();
    const qStr = String(q || "").trim();
    const qRegex = qStr ? new RegExp(escapeRegex(qStr), "i") : null;

    const start = parseDateStart(dateFrom);
    const end = parseDateEnd(dateTo);

    const { rateType: defaultRateType, rate: defaultRate } =
      await getDefaultCommissionRate();

    const match = { status: "paid" }; // unsettled = paid invoices not in settlements

    if (start || end) {
      match.createdAt = {};
      if (start) match.createdAt.$gte = start;
      if (end) match.createdAt.$lte = end;
    }

    if (sid) {
      const sidObj = toObjectId(sid);
      match.$or = [{ sellerId: sid }, ...(sidObj ? [{ sellerId: sidObj }] : [])];
    }

    const pipeline = [
      { $match: match },

      {
        $addFields: {
          invoiceIdObj: "$_id",
          invoiceIdStr: { $toString: "$_id" },

          sellerObjId: {
            $convert: {
              input: "$sellerId",
              to: "objectId",
              onError: null,
              onNull: null,
            },
          },
          sellerIdStr: { $toString: "$sellerId" },
          orderIdStr: { $toString: "$orderId" },

          _gross: {
            $convert: {
              input: {
                $ifNull: [
                  "$totals.grandTotal",
                  { $ifNull: ["$grandTotal", { $ifNull: ["$totalAmount", 0] }] },
                ],
              },
              to: "double",
              onError: 0,
              onNull: 0,
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
      { $unwind: { path: "$seller", preserveNullAndEmptyArrays: true } },

      {
        $addFields: {
          _rateType: {
            $toLower: { $ifNull: ["$commission.rateType", defaultRateType] },
          },
          _rate: { $ifNull: ["$commission.rate", defaultRate] },
          _commission: {
            $convert: {
              input: {
                $ifNull: [
                  "$commission.amount",
                  {
                    $cond: [
                      {
                        $eq: [
                          {
                            $toLower: {
                              $ifNull: ["$commission.rateType", defaultRateType],
                            },
                          },
                          "flat",
                        ],
                      },
                      { $ifNull: ["$commission.rate", defaultRate] },
                      {
                        $round: [
                          {
                            $divide: [
                              {
                                $multiply: [
                                  "$_gross",
                                  { $ifNull: ["$commission.rate", defaultRate] },
                                ],
                              },
                              100,
                            ],
                          },
                          2,
                        ],
                      },
                    ],
                  },
                ],
              },
              to: "double",
              onError: 0,
              onNull: 0,
            },
          },
          sellerName: {
            $ifNull: [
              "$seller.storeName",
              {
                $ifNull: [
                  "$seller.shopName",
                  { $ifNull: ["$seller.fullName", "$seller.email"] },
                ],
              },
            ],
          },
          sellerEmail: "$seller.email",
        },
      },

      { $addFields: { _net: { $max: [{ $subtract: ["$_gross", "$_commission"] }, 0] } } },

      // Exclude invoices already included in a settlement
      {
        $lookup: {
          from: "settlements",
          let: { invObj: "$invoiceIdObj", invStr: "$invoiceIdStr" },
          pipeline: [
            {
              $match: {
                $expr: {
                  $or: [
                    { $in: ["$$invObj", { $ifNull: ["$invoiceIds", []] }] },
                    { $in: ["$$invStr", { $ifNull: ["$invoiceIds", []] }] },
                    {
                      $in: [
                        "$$invObj",
                        {
                          $map: {
                            input: { $ifNull: ["$invoices", []] },
                            as: "it",
                            in: "$$it.invoiceId",
                          },
                        },
                      ],
                    },
                    {
                      $in: [
                        "$$invStr",
                        {
                          $map: {
                            input: { $ifNull: ["$invoices", []] },
                            as: "it",
                            in: { $toString: "$$it.invoiceId" },
                          },
                        },
                      ],
                    },
                  ],
                },
              },
            },
            { $project: { _id: 1 } },
            { $limit: 1 },
          ],
          as: "_settlementHit",
        },
      },
      { $addFields: { _isSettled: { $gt: [{ $size: "$_settlementHit" }, 0] } } },
      { $match: { _isSettled: false } },

      ...(qRegex
        ? [
            {
              $match: {
                $or: [
                  { invoiceNumber: qRegex },
                  { orderIdStr: qRegex },
                  { sellerIdStr: qRegex },
                  { sellerName: qRegex },
                  { sellerEmail: qRegex },
                ],
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
                invoiceNumber: 1,
                orderId: 1,
                sellerId: 1,
                status: 1,
                createdAt: 1,
                seller: {
                  storeName: "$seller.storeName",
                  shopName: "$seller.shopName",
                  email: "$seller.email",
                },
                grandTotal: "$_gross",
                commissionAmount: "$_commission",
                sellerNetAmount: "$_net",
              },
            },
          ],
          meta: [{ $count: "total" }],
          summary: [
            {
              $group: {
                _id: null,
                count: { $sum: 1 },
                gross: { $sum: "$_gross" },
                commission: { $sum: "$_commission" },
                net: { $sum: "$_net" },
              },
            },
            { $project: { _id: 0 } },
          ],
        },
      },
    ];

    const out = await Invoices.aggregate(pipeline, { allowDiskUse: true }).toArray();
    const result = out?.[0] || {};
    const invoices = result.rows || [];
    const total = result.meta?.[0]?.total || 0;
    const summary =
      result.summary?.[0] || { count: 0, gross: 0, commission: 0, net: 0 };

    return res.json({
      success: true,
      invoices,
      total,
      page: pageNum,
      limit: limitNum,
      totalPages: Math.max(1, Math.ceil(total / limitNum)),
      summary,
    });
  } catch (err) {
    console.error("admin commission unsettled error:", err);
    return res.status(500).json({
      success: false,
      message: "Failed to load unsettled commissions",
    });
  }
});

export default router;
