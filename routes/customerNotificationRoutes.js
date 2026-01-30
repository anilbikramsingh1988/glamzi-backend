// routes/customerNotificationRoutes.js
import express from "express";
import { ObjectId } from "mongodb";
import { client } from "../dbConfig.js";
import { authMiddleware, isCustomerMiddleware } from "../middlewares/authMiddleware.js";

const router = express.Router();

const dbName = process.env.DB_NAME || "glamzi_ecommerce";
const db = client.db(dbName);
const CustomerNotifications = db.collection("customerNotifications");

router.get("/notifications/unread-count", authMiddleware, isCustomerMiddleware, async (req, res) => {
  try {
    const userId = req.user?._id || req.user?.id || null;
    if (!userId) return res.status(401).json({ message: "Unauthorized" });

    const oid = userId instanceof ObjectId ? userId : new ObjectId(userId);
    const count = await CustomerNotifications.countDocuments({
      $or: [{ userId: oid }, { userId: String(oid) }],
      isRead: false,
    });
    res.json({ count });
  } catch (error) {
    console.error("Error fetching customer notification count:", error);
    res.status(500).json({ message: "Failed to fetch notification count" });
  }
});

router.get("/notifications/items", authMiddleware, isCustomerMiddleware, async (req, res) => {
  try {
    const userId = req.user?._id || req.user?.id || null;
    if (!userId) return res.status(401).json({ message: "Unauthorized" });

    const oid = userId instanceof ObjectId ? userId : new ObjectId(userId);
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
    const items = await CustomerNotifications.find({
      $or: [{ userId: oid }, { userId: String(oid) }],
    })
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();
    res.json({ items });
  } catch (error) {
    console.error("Error fetching customer notifications:", error);
    res.status(500).json({ message: "Failed to fetch notifications" });
  }
});

router.patch("/notifications/:id/read", authMiddleware, isCustomerMiddleware, async (req, res) => {
  try {
    const userId = req.user?._id || req.user?.id || null;
    if (!userId) return res.status(401).json({ message: "Unauthorized" });

    const oid = userId instanceof ObjectId ? userId : new ObjectId(userId);
    const { id } = req.params;
    await CustomerNotifications.updateOne(
      {
        _id: new ObjectId(id),
        $or: [{ userId: oid }, { userId: String(oid) }],
      },
      { $set: { isRead: true, readAt: new Date() } }
    );
    res.json({ message: "Notification marked as read" });
  } catch (error) {
    console.error("Error marking customer notification read:", error);
    res.status(500).json({ message: "Failed to update notification" });
  }
});

export default router;
