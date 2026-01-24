// routes/sellerReturnsRoutes.js
import express from "express";
import { client } from "../dbConfig.js";
import { authMiddleware } from "../middlewares/authMiddleware.js";
import { RETURN_STATUS } from "../utils/returnsStatus.js";
import {
  toObjectId,
  safeStr,
  actorFromReq,
  casReturnStatus,
  now,
} from "./_returnHelpers.js";

const router = express.Router();

const dbName = process.env.DB_NAME || "glamzi_ecommerce";
const db = client.db(dbName);

const Returns = db.collection("returns");
const Orders = db.collection("orders");
const Users = db.collection("users");

/* ----------------------------- helpers ----------------------------- */

function requireSeller(req, res) {
  const u = req.user;
  if (!u || u.role !== "seller") {
    res.status(403).json({ message: "Seller access only" });
    return null;
  }

  const sellerId = String(u.sellerId || u._id || u.id || req.userId || "").trim();
  if (!sellerId) {
    res.status(401).json({ message: "Invalid seller session" });
    return null;
  }

  return { u, sellerId };
}

async function enrichCustomerNameIfMissing(returnDoc) {
  if (!returnDoc) return returnDoc;

  let customerName =
    returnDoc.customer?.name ||
    returnDoc.customerName ||
    returnDoc.request?.customerName ||
    "";

  if (customerName) return { ...returnDoc, customerName };

  const orderIdObj = toObjectId(returnDoc.orderId);
  if (!orderIdObj) return returnDoc;

  const order = await Orders.findOne(
    { _id: orderIdObj },
    { projection: { userId: 1, customerId: 1 } }
  );

  const customerId = order?.userId || order?.customerId;
  const customerObj = toObjectId(customerId);
  if (!customerObj) return returnDoc;

  const customer = await Users.findOne(
    { _id: customerObj },
    { projection: { name: 1, fullName: 1, firstName: 1, lastName: 1 } }
  );

  customerName =
    (customer?.fullName ||
      customer?.name ||
      `${customer?.firstName || ""} ${customer?.lastName || ""}`.trim()) ||
    "";

  return customerName ? { ...returnDoc, customerName } : returnDoc;
}

/**
 * STATUS MACHINE (aligned to your agreed list)
 * pending | under_review | approved_awaiting_pickup | pickup_scheduled |
 * picked_up | received_by_seller | refunded | rejected | cancelled_by_customer
 */

/* ----------------------------- routes ----------------------------- */

async function fetchSellerList({ sellerId, status }) {
  const q = { sellerId };
  if (status) q.status = status;

  const rows = await Returns.find(q)
    .sort({ updatedAt: -1 })
    .limit(200)
    .toArray();

  return rows;
}

/**
 * SELLER LIST
 * When mounted at:
 * - /api/seller/returns     => GET /api/seller/returns
 * - /api/returns/seller     => GET /api/returns/seller
 */
router.get("/", authMiddleware, async (req, res) => {
  try {
    const session = requireSeller(req, res);
    if (!session) return;

    const { sellerId } = session;
    const status = safeStr(req.query.status, 40);

    const rows = await fetchSellerList({ sellerId, status });
    return res.json({ returns: rows });
  } catch (err) {
    console.error("GET seller returns error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

/**
 * SELLER QUEUE
 * - /api/seller/returns/queue
 * - /api/returns/seller/queue
 */
router.get("/queue", authMiddleware, async (req, res) => {
  try {
    const session = requireSeller(req, res);
    if (!session) return;

    const { sellerId } = session;
    const status = safeStr(req.query.status, 40);

    const rows = await fetchSellerList({ sellerId, status });
    return res.json({ returns: rows });
  } catch (err) {
    console.error("GET seller returns queue error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

/**
 * SELLER DETAIL
 * - /api/seller/returns/:id
 * - /api/returns/seller/:id
 */
router.get("/:id", authMiddleware, async (req, res) => {
  try {
    const session = requireSeller(req, res);
    if (!session) return;

    const { sellerId } = session;

    const id = toObjectId(req.params.id);
    if (!id) return res.status(400).json({ message: "Invalid id" });

    const doc = await Returns.findOne({ _id: id, sellerId });
    if (!doc) return res.status(404).json({ message: "Not found" });

    const enriched = await enrichCustomerNameIfMissing(doc);
    return res.json({ return: enriched });
  } catch (err) {
    console.error("GET seller return detail error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

/**
 * SELLER DECISION
 * PATCH:
 * - /api/seller/returns/:id/decision
 * - /api/returns/seller/:id/decision
 *
 * Allowed only from under_review.
 */
async function handleSellerDecision(req, res) {
  try {
    const session = requireSeller(req, res);
    if (!session) return;

    const { sellerId } = session;

    const id = toObjectId(req.params.id);
    if (!id) return res.status(400).json({ message: "Invalid id" });

    const doc = await Returns.findOne({ _id: id, sellerId });
    if (!doc) return res.status(404).json({ message: "Not found" });

    if (doc.status !== RETURN_STATUS.under_review) {
      return res.status(409).json({ message: "Decision allowed only in under_review." });
    }

    const decisionRaw = String(req.body?.decision || "").trim().toLowerCase();
    const note = safeStr(req.body?.note, 800);
    const actor = actorFromReq(req, "seller");

    if (decisionRaw === "approve") {
      const updated = await casReturnStatus({
        Returns,
        returnId: id,
        expectedStatus: RETURN_STATUS.under_review,
        nextStatus: RETURN_STATUS.approved_awaiting_pickup,
        actor,
        extraSet: {
          "seller.decision.status": "approved",
          "seller.decision.decidedAt": now(),
          "seller.decision.decidedBy": { userId: actor.userId, name: actor.name },
          "seller.decision.note": note || null,
        },
        extraPushHistory: { message: "Seller approved return." },
      });
      return res.json({ return: updated });
    }

    if (decisionRaw === "reject") {
      const updated = await casReturnStatus({
        Returns,
        returnId: id,
        expectedStatus: RETURN_STATUS.under_review,
        nextStatus: RETURN_STATUS.rejected,
        actor,
        extraSet: {
          "seller.decision.status": "rejected",
          "seller.decision.decidedAt": now(),
          "seller.decision.decidedBy": { userId: actor.userId, name: actor.name },
          "seller.decision.note": note || null,
        },
        extraPushHistory: { message: "Seller rejected return." },
      });
      return res.json({ return: updated });
    }

    return res.status(400).json({ message: "decision must be approve or reject" });
  } catch (err) {
    console.error("PATCH seller decision error:", err);
    return res
      .status(err.statusCode || 500)
      .json({ message: err.message || "Server error" });
  }
}

router.patch("/:id/decision", authMiddleware, handleSellerDecision);

/**
 * SELLER RECEIVED CONFIRMATION
 * PATCH:
 * - /api/seller/returns/:id/received
 * - /api/returns/seller/:id/received
 *
 * Allowed only from picked_up (per your agreed simplified list).
 */
router.patch("/:id/received", authMiddleware, async (req, res) => {
  try {
    const session = requireSeller(req, res);
    if (!session) return;

    const { sellerId } = session;

    const id = toObjectId(req.params.id);
    if (!id) return res.status(400).json({ message: "Invalid id" });

    const doc = await Returns.findOne({ _id: id, sellerId });
    if (!doc) return res.status(404).json({ message: "Not found" });

    const allowedForReceipt = new Set([RETURN_STATUS.picked_up, RETURN_STATUS.delivered_to_seller]);

    if (!allowedForReceipt.has(doc.status)) {
      return res.status(409).json({
        message: "Can mark received only after picked_up or delivered_to_seller.",
        status: doc.status,
      });
    }

    if (doc?.seller?.decision?.status !== "approved") {
      return res.status(409).json({ message: "Cannot receive a return that was not approved." });
    }

    const note = safeStr(req.body?.note, 800);
    const actor = actorFromReq(req, "seller");

    const updated = await casReturnStatus({
      Returns,
      returnId: id,
      expectedStatus: doc.status, // allow picked_up or delivered_to_seller
      nextStatus: RETURN_STATUS.received_by_seller,
      actor,
      extraSet: {
        "seller.receipt.receivedAt": now(),
        "seller.receipt.receivedBy": { userId: actor.userId, name: actor.name },
        "seller.receipt.note": note || null,
      },
      extraPushHistory: { message: "Seller marked received_by_seller." },
    });

    return res.json({ return: updated });
  } catch (err) {
    console.error("PATCH seller received error:", err);
    return res
      .status(err.statusCode || 500)
      .json({ message: err.message || "Server error" });
  }
});

/**
 * SELLER INSPECTION DECISION (after receipt)
 * PATCH:
 * - /api/seller/returns/:id/inspection
 * - /api/returns/seller/:id/inspection
 *
 * Allowed from: received_by_seller (or delivered_to_seller if you skip receipt step)
 * decision: approve | reject
 */
router.patch("/:id/inspection", authMiddleware, async (req, res) => {
  try {
    const session = requireSeller(req, res);
    if (!session) return;

    const { sellerId } = session;

    const id = toObjectId(req.params.id);
    if (!id) return res.status(400).json({ message: "Invalid id" });

    const decision = String(req.body?.decision || "").trim().toLowerCase();
    if (!["approve", "reject"].includes(decision)) {
      return res.status(400).json({ message: "decision must be approve or reject" });
    }

    const doc = await Returns.findOne({ _id: id, sellerId });
    if (!doc) return res.status(404).json({ message: "Not found" });

    const cur = doc.status;
    const allowedCurrent = new Set([RETURN_STATUS.received_by_seller, RETURN_STATUS.delivered_to_seller]);
    if (!allowedCurrent.has(cur)) {
      return res.status(409).json({
        message: "Inspection decision allowed only after receipt",
        status: doc.status,
      });
    }

    const next =
      decision === "approve" ? RETURN_STATUS.inspection_approved : RETURN_STATUS.inspection_rejected;

    const actor = actorFromReq(req, "seller");
    const note = safeStr(req.body?.note, 800);

    const updated = await casReturnStatus({
      Returns,
      returnId: id,
      expectedStatus: cur,
      nextStatus: next,
      actor,
      extraSet: {
        "inspection.decidedAt": now(),
        "inspection.decidedBy": { userId: actor.userId, name: actor.name },
        "inspection.note": note || null,
      },
      extraPushHistory: { message: `Seller ${decision} inspection.` },
    });

    return res.json({ return: updated });
  } catch (err) {
    console.error("PATCH seller inspection error:", err);
    return res
      .status(err.statusCode || 500)
      .json({ message: err.message || "Server error" });
  }
});

export { handleSellerDecision };
export default router;
