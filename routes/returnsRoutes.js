// routes/returnsRoutes.js
import express from "express";

import { client } from "../dbConfig.js";
import { authMiddleware } from "../middlewares/authMiddleware.js";

import {
  RETURN_STATUS,
  normalizeReturnStatus,
  canTransitionReturnStatus,
  isActiveReturnStatus,
  isTerminalReturnStatus,
} from "../utils/returnsStatus.js";

import { toObjectId, now, safeStr, actorFromReq, pushHistory } from "./_returnHelpers.js";
import { logReturnIssue } from "../utils/returnLog.js";

const router = express.Router();

const dbName = process.env.DB_NAME || "glamzi_ecommerce";
const db = client.db(dbName);

const Returns = db.collection("returns");
const Orders = db.collection("orders");
const AdminNotifications = db.collection("admin_notifications");

/* ------------------------- helpers ------------------------- */

/**
 * Build snapshot pricing for requested return lines.
 * IMPORTANT: Must use immutable data from the order snapshot.
 * Do NOT read live product prices here.
 */
function normalizeReturnKey(value) {
  if (!value && value !== 0) return null;

  if (typeof value === "object") {
    if (typeof value.toHexString === "function") return value.toHexString();

    if (typeof value.toString === "function") {
      const str = value.toString();
      const match = str.match(/ObjectId\("([0-9a-fA-F]{24})"\)/);
      if (match) return match[1];
      return str;
    }
  }

  const str = String(value).trim();
  const match = str.match(/^ObjectId\("([0-9a-fA-F]{24})"\)$/);
  if (match) return match[1];

  return str || null;
}

function safeNum(n, fallback = 0) {
  const x = Number(n);
  return Number.isFinite(x) ? x : fallback;
}

function buildReturnItemSnapshotsFromOrder({ order, sellerId, requestedItems }) {
  // requestedItems: [{ orderItemId, qty }]
  const mapReq = new Map();
  for (const it of requestedItems || []) {
    const key = normalizeReturnKey(it?.orderItemId);
    const qty = safeNum(it?.qty, 0);
    if (key && qty > 0) mapReq.set(key, qty);
  }

  const out = [];

  for (const line of order.items || []) {
    if (String(line?.sellerId) !== String(sellerId)) continue;

    const candidates = [
      normalizeReturnKey(line?.orderItemId),
      normalizeReturnKey(line?._id),
      normalizeReturnKey(line?.productId),
    ].filter(Boolean);

    const matchedKey = candidates.find((k) => mapReq.has(k));
    if (!matchedKey) continue;

    const orderItemId = matchedKey;

    const lineQty = safeNum(line?.qty ?? line?.quantity ?? line?.qtyOrdered, 0);
    const qtyRequestedReturn = Math.min(safeNum(mapReq.get(orderItemId), 0), lineQty);
    if (qtyRequestedReturn <= 0) continue;

    // Paid snapshot (use your canonical order snapshot keys)
    const unitPricePaid = safeNum(line?.pricePaid ?? line?.price ?? line?.unitPrice, 0);
    const currency = String(order.currency || "NPR");

    const denom = Math.max(1, safeNum(line?.qty ?? lineQty, 1));
    const shippingAlloc = safeNum(line?.shippingAllocation, 0) * (qtyRequestedReturn / denom);

    const lineSubtotalPaid = unitPricePaid * qtyRequestedReturn;

    // Discounts / tax snapshots (prorated)
    const sellerDiscountShare = safeNum(line?.sellerDiscountAmount, 0) * (qtyRequestedReturn / denom);
    const adminDiscountShare = safeNum(line?.adminDiscountAmount, 0) * (qtyRequestedReturn / denom);
    const taxPaid = safeNum(line?.taxPaid, 0) * (qtyRequestedReturn / denom);

    // Policy choice:
    // Here: admin-funded discounts are NOT refunded by default.
    const adminDiscountRefundForLine = 0;

    const totalPaidForReturnLine =
      lineSubtotalPaid + taxPaid + shippingAlloc - adminDiscountRefundForLine;

    const commission = line?.commissionSnapshot || {
      rateType: String(line?.commissionRateType || "percentage"),
      rate: safeNum(line?.commissionRate, 0),
      baseAmount: lineSubtotalPaid,
      amount: safeNum(line?.commissionAmount, 0) * (qtyRequestedReturn / denom),
    };

    out.push({
      orderItemId,
      productId: toObjectId(line?.productId) || line?.productId,
      title: String(line?.title || line?.name || ""),
      sku: String(line?.sku || ""),
      variant: String(line?.variant || ""),
      qtyOrdered: safeNum(line?.qty ?? lineQty, 0),
      qtyRequestedReturn,
      pricing: {
        currency,
        unitPricePaid,
        lineSubtotalPaid,
        sellerDiscountShare,
        adminDiscountShare,
        taxPaid,
        shippingPaidAllocation: shippingAlloc,
        adminDiscountRefund: adminDiscountRefundForLine,
        totalPaidForReturnLine,
      },
      commission: {
        rateType: String(commission?.rateType || "percentage"),
        rate: safeNum(commission?.rate, 0),
        baseAmount: safeNum(commission?.baseAmount ?? lineSubtotalPaid, lineSubtotalPaid),
        amount: safeNum(commission?.amount, 0),
      },
    });
  }

  return out;
}

function computeRefundSnapshot({ order, items }) {
  const currency = String(order.currency || "NPR");

  const subtotal = items.reduce((s, it) => s + safeNum(it?.pricing?.lineSubtotalPaid, 0), 0);
  const shippingRefund = items.reduce((s, it) => s + safeNum(it?.pricing?.shippingPaidAllocation, 0), 0);
  const taxRefund = items.reduce((s, it) => s + safeNum(it?.pricing?.taxPaid, 0), 0);

  // Policy choice:
  // If admin-funded coupons are refundable, compute/prorate here.
  const adminDiscountRefund = 0;

  const totalRefund = subtotal + shippingRefund + taxRefund - adminDiscountRefund;

  const paymentMethod = String(order.paymentMethod || "cod").toLowerCase() === "prepaid" ? "prepaid" : "cod";
  const strategy = paymentMethod === "prepaid" ? "card_refund" : "cod_settlement_adjustment";

  const commissionReversal = items.reduce(
    (acc, it) => {
      acc.baseAmount += safeNum(it?.commission?.baseAmount, 0);
      acc.amount += safeNum(it?.commission?.amount, 0);
      return acc;
    },
    { rateType: "mixed", rate: null, baseAmount: 0, amount: 0 }
  );

  return {
    currency,
    subtotal,
    shippingRefund,
    taxRefund,
    adminDiscountRefund,
    totalRefund,
    paymentMethod,
    strategy,
    status: "not_started",
    commissionReversal,
  };
}

function deriveIsActiveFromStatus(status) {
  const s = normalizeReturnStatus(status);
  return Boolean(isActiveReturnStatus(s) && !isTerminalReturnStatus(s));
}

/* ------------------------- routes ------------------------- */

/**
 * CUSTOMER: POST /api/returns
 * Supports:
 *  A) single seller return: { orderId, sellerId, items: [{orderItemId, qty}], reasonCode, reasonText, attachments[] }
 *  B) multi-seller: { orderId, itemsBySeller: [{ sellerId, items:[{orderItemId, qty}] }], ... }
 *
 * Creates ONE return doc per sellerId.
 *
 * IMPORTANT: Enforced by unique partial index `uniq_order_seller_active`:
 * - orderId (ObjectId) + sellerId (string) unique for ACTIVE return docs (status-driven or isActive-driven).
 */
router.post("/", authMiddleware, async (req, res) => {
  try {
    const customer = req.user;
    const customerId = toObjectId(customer?._id);
    if (!customerId) return res.status(401).json({ message: "Unauthorized" });

    const orderId = toObjectId(req.body?.orderId);
    if (!orderId) return res.status(400).json({ message: "orderId required" });

    const order = await Orders.findOne({ _id: orderId, userId: customerId });
    if (!order) return res.status(404).json({ message: "Order not found" });

    // Optional policy: allow returns only after delivery/completion.
    // If you want to enforce strictly, uncomment this block.
    //
    // const orderStatus = String(order.status || "").toLowerCase();
    // if (!["delivered", "completed"].includes(orderStatus)) {
    //   return res.status(409).json({ message: "Returns are available only after delivery." });
    // }

    const reasonCode = safeStr(req.body?.reasonCode, 50) || "other";
    const reasonText = safeStr(req.body?.reasonText, 800);

    const attachments = Array.isArray(req.body?.attachments) ? req.body.attachments.slice(0, 10) : [];
    const signals = req.body?.signals && typeof req.body.signals === "object" ? req.body.signals : {};

    const sellerRequests = [];

    if (req.body?.sellerId) {
      sellerRequests.push({
        sellerId: String(req.body.sellerId),
        items: Array.isArray(req.body.items) ? req.body.items : [],
      });
    } else if (Array.isArray(req.body?.itemsBySeller)) {
      for (const entry of req.body.itemsBySeller) {
        if (!entry?.sellerId) continue;
        sellerRequests.push({
          sellerId: String(entry.sellerId),
          items: Array.isArray(entry.items) ? entry.items : [],
        });
      }
    } else {
      return res.status(400).json({ message: "Provide sellerId + items[] OR itemsBySeller[]" });
    }

    if (sellerRequests.length === 0) {
      return res.status(400).json({ message: "No seller return requests found." });
    }

    const created = [];

    for (const sr of sellerRequests) {
      const sellerId = String(sr?.sellerId || "").trim();
      if (!sellerId) continue;

      const itemSnapshots = buildReturnItemSnapshotsFromOrder({
        order,
        sellerId,
        requestedItems: sr?.items,
      });

      if (itemSnapshots.length === 0) continue;

      const refundSnapshot = computeRefundSnapshot({ order, items: itemSnapshots });

      // attempt number is "count of historical attempts + 1"
      const prevCount = await Returns.countDocuments({ orderId, sellerId });
      const attempt = prevCount + 1;

      // Canonical initial status per your workflow
      const initialStatus = RETURN_STATUS.under_review;

      const doc = {
        orderId,
        orderNumber: String(order.orderNumber || order.number || ""),
        sellerId,
        customerId,

        status: initialStatus,
        attempt,

        request: {
          reasonCode,
          reasonText,
          requestedAt: now(),
          items: itemSnapshots,
          attachments: attachments
            .map((a) => ({
              key: safeStr(a?.key || a, 500),
              mime: safeStr(a?.mime, 80),
              uploadedAt: now(),
            }))
            .filter((x) => x.key),
          signals,
        },

        seller: {
          queue: {
            assignedAt: now(),
            slaDueAt: new Date(Date.now() + 48 * 60 * 60 * 1000),
          },
          decision: { status: null, decidedAt: null, decidedBy: null, note: null },
          receipt: { receivedAt: null, receivedBy: null, note: null, attachments: [] },
        },

        // Pickup will be booked by admin flow (or future auto-booking) and then updated by callbacks
        pickup: {
          shipmentId: null,
          trackingNumber: null,
          partner: "everestx",
          bookedAt: null,
          from: null,
          to: null,
          statusExternal: null,
          events: [],
          bookingKey: `return:${String(order.orderNumber || order._id)}:seller:${sellerId}:attempt:${attempt}`,
          lastWebhookAt: null,
        },

        refund: refundSnapshot,

        history: [
          pushHistory(
            { role: "customer", userId: customerId, name: customer?.name || null },
            {
              type: "STATUS_CHANGE",
              fromStatus: null,
              toStatus: initialStatus,
              message: "Return requested.",
              meta: { attempt },
            }
          ),
        ],

        version: 1,
        isActive: deriveIsActiveFromStatus(initialStatus),
        createdAt: now(),
        updatedAt: now(),
      };

      // Insert with unique partial index protection (`uniq_order_seller_active`)
      const ins = await Returns.insertOne(doc);
      created.push({ returnId: ins.insertedId, sellerId });
    }

    if (created.length === 0) {
      const requestSnapshot = {
        customerId: String(customerId),
        orderId: String(orderId),
        sellers: sellerRequests.map((sr) => ({
          sellerId: String(sr?.sellerId || ""),
          items: (sr?.items || []).map((it) => ({
            orderItemId: String(it?.orderItemId || ""),
            qty: safeNum(it?.qty, 0),
          })),
        })),
        reasonCode,
        reasonText,
      };

      await logReturnIssue("no-valid-items", requestSnapshot);
      return res.status(400).json({ message: "No valid seller return items found." });
    }

    await AdminNotifications.insertOne({
      type: "return_pending",
      title: "Return request pending",
      message: `New return request for order ${order?.orderNumber || order?._id || ""}`,
      link: "/returns",
      read: false,
      createdAt: now(),
    });

    return res.status(201).json({ message: "Return request created.", created });
  } catch (err) {
    // Duplicate active return (status-driven partial unique index)
    if (err?.code === 11000) {
      return res
        .status(409)
        .json({ message: "An active return already exists for this seller on this order." });
    }

    console.error("POST /api/returns error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

/**
 * CUSTOMER: GET /api/returns/my
 * Optional query params:
 *  - active=true  => only active returns
 *  - limit=1..200
 */
router.get("/my", authMiddleware, async (req, res) => {
  try {
    const customerId = toObjectId(req.user?._id);
    if (!customerId) return res.status(401).json({ message: "Unauthorized" });

    const activeOnly = String(req.query?.active || "").toLowerCase() === "true";
    const limitRaw = Number.parseInt(req.query?.limit, 10);
    const limit = Number.isFinite(limitRaw) ? Math.min(200, Math.max(1, limitRaw)) : 200;

    const base = {
      $or: [{ customerId }, { customerId: String(customerId) }], // backward compat if old docs stored string
    };

    if (activeOnly) {
      base.isActive = true;
    }

    const rows = await Returns.find(base).sort({ createdAt: -1 }).limit(limit).toArray();
    return res.json({ returns: rows });
  } catch (err) {
    console.error("GET /api/returns/my error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

/**
 * CUSTOMER: GET /api/returns/:id
 */
router.get("/:id", authMiddleware, async (req, res) => {
  try {
    const customerId = toObjectId(req.user?._id);
    if (!customerId) return res.status(401).json({ message: "Unauthorized" });

    const id = toObjectId(req.params.id);
    if (!id) return res.status(400).json({ message: "Invalid id" });

    const doc = await Returns.findOne({
      _id: id,
      $or: [{ customerId }, { customerId: String(customerId) }],
    });

    if (!doc) return res.status(404).json({ message: "Not found" });

    return res.json({ return: doc });
  } catch (err) {
    console.error("GET /api/returns/:id error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

/**
 * CUSTOMER: PATCH /api/returns/:id/cancel
 * Allowed only in early states: pending, under_review
 */
router.patch("/:id/cancel", authMiddleware, async (req, res) => {
  try {
    const customerId = toObjectId(req.user?._id);
    if (!customerId) return res.status(401).json({ message: "Unauthorized" });

    const id = toObjectId(req.params.id);
    if (!id) return res.status(400).json({ message: "Invalid id" });

    const doc = await Returns.findOne({
      _id: id,
      $or: [{ customerId }, { customerId: String(customerId) }],
    });

    if (!doc) return res.status(404).json({ message: "Not found" });

    const fromStatus = normalizeReturnStatus(doc.status);

    // Strict early-only cancel policy
    if (![RETURN_STATUS.pending, RETURN_STATUS.under_review].includes(fromStatus)) {
      return res.status(409).json({ message: "Cannot cancel at this stage." });
    }

    if (!canTransitionReturnStatus(fromStatus, RETURN_STATUS.cancelled_by_customer, "customer")) {
      return res.status(409).json({ message: "Cancel transition not allowed." });
    }

    const note = safeStr(req.body?.note, 600);

    const updated = await Returns.findOneAndUpdate(
      { _id: id, status: fromStatus },
      {
        $set: {
          status: RETURN_STATUS.cancelled_by_customer,
          isActive: false,
          closedAt: now(),
          updatedAt: now(),
        },
        $inc: { version: 1 },
        $push: {
          history: {
            $each: [
              pushHistory(actorFromReq(req, "customer"), {
                type: "STATUS_CHANGE",
                fromStatus,
                toStatus: RETURN_STATUS.cancelled_by_customer,
                message: note || "Cancelled by customer.",
                meta: {},
              }),
            ],
          },
        },
      },
      { returnDocument: "after" }
    );

    if (!updated.value) return res.status(409).json({ message: "Conflict; refresh and retry." });

    return res.json({ return: updated.value });
  } catch (err) {
    console.error("PATCH /api/returns/:id/cancel error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

export default router;
