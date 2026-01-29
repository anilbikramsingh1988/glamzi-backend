// routes/sellerNotificationRoutes.js
import express from "express";
import { ObjectId } from "mongodb";
import { client } from "../dbConfig.js";
import { authMiddleware } from "../middlewares/authMiddleware.js";
import {
  getVapidPublicKey,
  upsertSellerSubscription,
  removeSellerSubscription,
} from "../utils/sellerPush.js";

const router = express.Router();

const dbName = process.env.DB_NAME || "glamzi_ecommerce";
const db = client.db(dbName);

const SellerNotifications = db.collection("seller_notifications");

function ensureSeller(req, res) {
  const role = String(req.user?.role || "").toLowerCase();
  if (role !== "seller") {
    res.status(403).json({ message: "Seller access only" });
    return false;
  }
  return true;
}

router.get("/notifications/vapid-public-key", authMiddleware, async (req, res) => {
  if (!ensureSeller(req, res)) return;
  res.json({ publicKey: getVapidPublicKey() });
});

router.post("/notifications/subscribe", authMiddleware, async (req, res) => {
  try {
    if (!ensureSeller(req, res)) return;
    const { subscription } = req.body || {};
    if (!subscription?.endpoint) {
      return res.status(400).json({ message: "Subscription is required" });
    }
    const sellerId = req.user?._id || req.user?.id || null;
    await upsertSellerSubscription({
      subscription,
      userId: sellerId,
      sellerId,
    });
    res.json({ message: "Subscription saved" });
  } catch (error) {
    console.error("Error saving seller subscription:", error);
    res.status(500).json({ message: "Failed to save subscription" });
  }
});

router.post("/notifications/unsubscribe", authMiddleware, async (req, res) => {
  try {
    if (!ensureSeller(req, res)) return;
    const { endpoint } = req.body || {};
    if (!endpoint) {
      return res.status(400).json({ message: "Endpoint is required" });
    }
    await removeSellerSubscription(endpoint);
    res.json({ message: "Subscription removed" });
  } catch (error) {
    console.error("Error removing seller subscription:", error);
    res.status(500).json({ message: "Failed to remove subscription" });
  }
});

router.get("/notifications/unread-count", authMiddleware, async (req, res) => {
  try {
    if (!ensureSeller(req, res)) return;
    const sellerId = String(req.user?._id || req.user?.id || "");
    const count = await SellerNotifications.countDocuments({
      sellerId,
      read: false,
    });
    res.json({ count });
  } catch (error) {
    console.error("Error fetching seller notification count:", error);
    res.status(500).json({ message: "Failed to fetch notification count" });
  }
});

router.get("/notifications/items", authMiddleware, async (req, res) => {
  try {
    if (!ensureSeller(req, res)) return;
    const sellerId = String(req.user?._id || req.user?.id || "");
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
    const items = await SellerNotifications.find({ sellerId })
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();
    res.json({ items });
  } catch (error) {
    console.error("Error fetching seller notifications:", error);
    res.status(500).json({ message: "Failed to fetch notifications" });
  }
});

router.patch("/notifications/:id/read", authMiddleware, async (req, res) => {
  try {
    if (!ensureSeller(req, res)) return;
    const { id } = req.params;
    const sellerId = String(req.user?._id || req.user?.id || "");
    await SellerNotifications.updateOne(
      { _id: new ObjectId(id), sellerId },
      { $set: { read: true, readAt: new Date() } }
    );
    res.json({ message: "Notification marked as read" });
  } catch (error) {
    console.error("Error marking seller notification read:", error);
    res.status(500).json({ message: "Failed to update notification" });
  }
});

export default router;
