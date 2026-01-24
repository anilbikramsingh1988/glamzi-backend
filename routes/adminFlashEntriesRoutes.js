// routes/adminFlashEntriesRoutes.js
// Admin moderation for seller-submitted flash entries

import express from "express";
import dotenv from "dotenv";
import { ObjectId } from "mongodb";

import { client } from "../dbConfig.js";
import {
  authMiddleware,
  isActiveMiddleware,
  isStaffMiddleware,
} from "../middlewares/authMiddleware.js";

dotenv.config();

const router = express.Router();

const dbName = process.env.DB_NAME || "glamzi_ecommerce";
const db = client.db(dbName);

const FlashEntries = db.collection("flashEntries");
const Discounts = db.collection("discounts");
const Users = db.collection("users");

const staffGuard = [authMiddleware, isActiveMiddleware, isStaffMiddleware];

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

// List flash entries (pending/approved/rejected)
router.get("/flash-entries", staffGuard, async (req, res) => {
  try {
    const status = req.query.status ? String(req.query.status).toLowerCase() : "";
    const campaignId = req.query.campaignId ? toObjectId(req.query.campaignId) : null;
    const sellerId = req.query.sellerId ? String(req.query.sellerId) : "";

    const filter = {};
    if (status) filter.status = status;
    if (campaignId) filter.campaignId = campaignId;
    if (sellerId) filter.sellerId = sellerId;

    const entries = await FlashEntries.find(filter)
      .sort({ status: 1, updatedAt: -1 })
      .limit(200)
      .toArray();

    // Enrich with seller email/name if available
    const sellerIds = Array.from(new Set(entries.map((e) => e.sellerId).filter(Boolean)));
    let sellerMap = new Map();
    if (sellerIds.length) {
      const sellers = await Users.find(
        { _id: { $in: sellerIds.map((sid) => toObjectId(sid)).filter(Boolean) } },
        { projection: { name: 1, email: 1, storeName: 1, shopName: 1 } }
      ).toArray();
      sellerMap = new Map(sellers.map((s) => [String(s._id), s]));
    }

    const result = entries.map((e) => ({
      ...e,
      seller: sellerMap.get(String(e.sellerId)) || null,
    }));

    res.json({ success: true, items: result });
  } catch (err) {
    console.error("GET /api/admin/flash-entries error:", err);
    res.status(500).json({ success: false, message: "Failed to load flash entries" });
  }
});

// Approve/reject entry
router.patch("/flash-entries/:id/status", staffGuard, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: "Invalid entry id" });

    const statusRaw = String(req.body?.status || "").toLowerCase();
    if (!["approved", "rejected", "pending"].includes(statusRaw)) {
      return res.status(400).json({ success: false, message: "Invalid status" });
    }

    const entry = await FlashEntries.findOne({ _id: id });
    if (!entry) return res.status(404).json({ success: false, message: "Entry not found" });

    const update = {
      status: statusRaw,
      note: req.body?.note ? String(req.body.note) : entry.note || null,
      updatedAt: new Date(),
    };

    await FlashEntries.updateOne({ _id: id }, { $set: update });

    // On approval, ensure the campaign has this productId in its productIds
    if (statusRaw === "approved") {
      const campaignId = entry.campaignId;
      if (campaignId) {
        await Discounts.updateOne(
          { _id: campaignId },
          {
            $addToSet: { productIds: entry.productId },
            $set: { updatedAt: new Date() },
          }
        );
      }
    }

    res.json({ success: true });
  } catch (err) {
    console.error("PATCH /api/admin/flash-entries/:id/status error:", err);
    res.status(500).json({ success: false, message: "Failed to update entry" });
  }
});

export default router;
