// routes/adminOutboxRoutes.js
import express from "express";
import { ObjectId } from "mongodb";
import { client } from "../dbConfig.js";
import { authMiddleware } from "../middlewares/authMiddleware.js";
import { isStaffMiddleware } from "../middlewares/authMiddleware.js";

const router = express.Router();
const db = client.db(process.env.DB_NAME || "glamzi_ecommerce");
const Outbox = db.collection("outbox");

const parseIntSafe = (v, fallback) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
};

router.get("/outbox", authMiddleware, isStaffMiddleware, async (req, res) => {
  try {
    const page = Math.max(1, parseIntSafe(req.query.page, 1));
    const limit = Math.min(100, Math.max(1, parseIntSafe(req.query.limit, 20)));
    const skip = (page - 1) * limit;

    const status = String(req.query.status || "").trim().toLowerCase();
    const type = String(req.query.type || "").trim();
    const q = String(req.query.q || "").trim();

    const match = {};
    if (status && status !== "all") match.status = status;
    if (type) match.type = type;
    if (q) {
      const rx = new RegExp(q, "i");
      match.$or = [
        { type: rx },
        { "payload.customerId": rx },
        { "payload.sellerId": rx },
        { "payload.orderId": rx },
        { "payload.orderNumber": rx },
      ];
    }

    const [items, total] = await Promise.all([
      Outbox.find(match).sort({ nextRunAt: 1, createdAt: -1 }).skip(skip).limit(limit).toArray(),
      Outbox.countDocuments(match),
    ]);

    res.json({ items, total, page, limit });
  } catch (err) {
    console.error("admin outbox list error:", err);
    res.status(500).json({ message: "Failed to load outbox" });
  }
});

router.get("/outbox/summary", authMiddleware, isStaffMiddleware, async (req, res) => {
  try {
    const [pending, failed, processing, done] = await Promise.all([
      Outbox.countDocuments({ status: "pending" }),
      Outbox.countDocuments({ status: "failed" }),
      Outbox.countDocuments({ status: "processing" }),
      Outbox.countDocuments({ status: "done" }),
    ]);
    res.json({ pending, failed, processing, done });
  } catch (err) {
    console.error("admin outbox summary error:", err);
    res.status(500).json({ message: "Failed to load outbox summary" });
  }
});

router.post("/outbox/:id/retry", authMiddleware, isStaffMiddleware, async (req, res) => {
  try {
    const id = req.params.id;
    const oid = new ObjectId(id);
    const now = new Date();
    await Outbox.updateOne(
      { _id: oid },
      {
        $set: {
          status: "pending",
          nextRunAt: now,
          lockedAt: null,
          lockedBy: null,
          updatedAt: now,
        },
      }
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("admin outbox retry error:", err);
    res.status(500).json({ message: "Failed to retry outbox item" });
  }
});

router.post("/outbox/retry-failed", authMiddleware, isStaffMiddleware, async (req, res) => {
  try {
    const now = new Date();
    const result = await Outbox.updateMany(
      { status: "failed" },
      {
        $set: {
          status: "pending",
          nextRunAt: now,
          lockedAt: null,
          lockedBy: null,
          updatedAt: now,
        },
      }
    );
    res.json({ ok: true, modified: result.modifiedCount || 0 });
  } catch (err) {
    console.error("admin outbox retry-failed error:", err);
    res.status(500).json({ message: "Failed to retry failed items" });
  }
});

export default router;
