// routes/flashReservationRoutes.js
// Minimal flash reservation endpoints: hold and commit

import express from "express";
import dotenv from "dotenv";
import { ObjectId } from "mongodb";

import { client } from "../dbConfig.js";
import { authMiddleware } from "../middlewares/authMiddleware.js";

dotenv.config();
const router = express.Router();

const dbName = process.env.DB_NAME || "glamzi_ecommerce";
const db = client.db(dbName);

const Discounts = db.collection("discounts");
const FlashReservations = db.collection("flashReservations");

const toObjectId = (id) => {
  if (!id) return null;
  const s = String(id).trim();
  if (!ObjectId.isValid(s)) return null;
  try {
    return new ObjectId(s);
  } catch {
    return null;
  }
};

const nowUtc = () => new Date();
const HOLD_MINUTES = 10;

// POST /api/flash/reservations/hold
router.post("/hold", authMiddleware, async (req, res) => {
  try {
    const userId = req.user?.id || req.user?._id || req.userId;
    if (!userId) return res.status(401).json({ success: false, message: "Unauthorized" });

    const discountId = toObjectId(req.body?.discountId);
    const productId = toObjectId(req.body?.productId);
    const qty = Number(req.body?.qty || 1);

    if (!discountId || !productId || !Number.isFinite(qty) || qty <= 0) {
      return res.status(400).json({ success: false, message: "Invalid payload" });
    }

    const campaign = await Discounts.findOne({ _id: discountId, saleType: "flash" });
    if (!campaign) return res.status(404).json({ success: false, message: "Flash not found" });

    const now = nowUtc();
    const start = campaign.startAt ? new Date(campaign.startAt) : null;
    const end = campaign.endAt ? new Date(campaign.endAt) : null;
    if ((start && now < start) || (end && now > end)) {
      return res.status(400).json({ success: false, message: "Flash not active" });
    }

    // Product eligibility
    const pidList = Array.isArray(campaign.productIds)
      ? campaign.productIds.map((p) => String(p))
      : [];
    if (pidList.length && !pidList.includes(String(productId))) {
      return res.status(400).json({ success: false, message: "Product not in flash sale" });
    }

    const total = Number(campaign?.limits?.totalQty ?? campaign?.totalQty ?? 0);
    const reserved = Number(campaign?.reservedQty ?? 0);
    const sold = Number(campaign?.soldQty ?? 0);
    const remaining = total ? Math.max(0, total - reserved - sold) : Infinity;
    if (qty > remaining) {
      return res.status(400).json({ success: false, message: "Insufficient flash inventory" });
    }

    // Enforce per-user cap (count held + committed reservations)
    const perUserCap = Number(campaign?.limits?.perUserQty ?? 0);
    if (perUserCap > 0) {
      const userUsage = await FlashReservations.aggregate([
        {
          $match: {
            discountId,
            productId,
            userId: String(userId),
            status: { $in: ["held", "committed"] },
          },
        },
        { $group: { _id: null, qty: { $sum: "$qty" } } },
      ]).toArray();
      const used = userUsage[0]?.qty || 0;
      if (used + qty > perUserCap) {
        return res.status(400).json({ success: false, message: "Per-user cap exceeded" });
      }
    }

    // Atomically reserve in discount doc
    const updated = await Discounts.findOneAndUpdate(
      {
        _id: discountId,
        saleType: "flash",
        $expr: {
          $lte: [{ $add: ["$reservedQty", "$soldQty", qty] }, { $ifNull: ["$limits.totalQty", 0] }],
        },
      },
      {
        $inc: { reservedQty: qty },
        $set: { updatedAt: new Date() },
      },
      { returnDocument: "after" }
    );

    if (!updated.value) {
      return res.status(400).json({ success: false, message: "Insufficient flash inventory" });
    }

    const reservation = {
      discountId,
      productId,
      userId: String(userId),
      qty,
      status: "held",
      createdAt: now,
      updatedAt: now,
      expiresAt: new Date(now.getTime() + HOLD_MINUTES * 60 * 1000),
    };

    const ins = await FlashReservations.insertOne(reservation);

    res.json({
      success: true,
      reservationId: ins.insertedId,
      expiresAt: reservation.expiresAt,
    });
  } catch (err) {
    console.error("POST /api/flash/reservations/hold error:", err);
    res.status(500).json({ success: false, message: "Failed to hold reservation" });
  }
});

// POST /api/flash/reservations/commit
router.post("/commit", authMiddleware, async (req, res) => {
  try {
    const userId = req.user?.id || req.user?._id || req.userId;
    if (!userId) return res.status(401).json({ success: false, message: "Unauthorized" });

    const reservationId = toObjectId(req.body?.reservationId);
    if (!reservationId) {
      return res.status(400).json({ success: false, message: "Invalid reservation id" });
    }

    const now = nowUtc();
    const reservation = await FlashReservations.findOne({ _id: reservationId });
    if (!reservation) return res.status(404).json({ success: false, message: "Not found" });
    if (String(reservation.userId) !== String(userId)) {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }
    if (reservation.status !== "held") {
      return res.status(400).json({ success: false, message: "Reservation not holdable" });
    }
    if (reservation.expiresAt && now > new Date(reservation.expiresAt)) {
      return res.status(400).json({ success: false, message: "Reservation expired" });
    }

    // Move from reserved -> sold: decrement reservedQty, increment soldQty
    await Discounts.updateOne(
      { _id: reservation.discountId },
      { $inc: { reservedQty: -reservation.qty, soldQty: reservation.qty }, $set: { updatedAt: now } }
    );

    await FlashReservations.updateOne(
      { _id: reservationId },
      { $set: { status: "committed", updatedAt: now, committedAt: now } }
    );

    res.json({ success: true });
  } catch (err) {
    console.error("POST /api/flash/reservations/commit error:", err);
    res.status(500).json({ success: false, message: "Failed to commit reservation" });
  }
});

export default router;
