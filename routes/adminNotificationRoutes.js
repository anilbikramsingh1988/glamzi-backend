import express from "express";
import { ObjectId } from "mongodb";
import { client } from "../dbConfig.js";
import { authMiddleware, isStaffMiddleware } from "../middlewares/authMiddleware.js";

const router = express.Router();
const db = client.db(process.env.DB_NAME || "glamzi_ecommerce");
const AdminNotifications = db.collection("admin_notifications");

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

async function sendExpoPushNotification(tokens, title, body, data = {}) {
  const messages = tokens.map(token => ({
    to: token,
    sound: "default",
    title,
    body,
    data
  }));

  try {
    const response = await fetch(EXPO_PUSH_URL, {
      method: "POST",
      headers: {
        "Accept": "application/json",
        "Accept-Encoding": "gzip, deflate",
        "Content-Type": "application/json"
      },
      body: JSON.stringify(messages)
    });
    return await response.json();
  } catch (error) {
    console.error("Error sending push notification:", error);
    throw error;
  }
}

router.get("/campaigns", authMiddleware, isStaffMiddleware, async (req, res) => {
  try {
    const { page = 1, limit = 20, status } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const filter = {};
    if (status) filter.status = status;

    const campaigns = await db.collection("notification_campaigns")
      .find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .toArray();

    const total = await db.collection("notification_campaigns").countDocuments(filter);

    res.json({
      campaigns,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (error) {
    console.error("Error fetching campaigns:", error);
    res.status(500).json({ message: "Failed to fetch campaigns" });
  }
});

// ------------------------------------------------------------------
// Admin in-app notifications (e.g., new seller requests)
// ------------------------------------------------------------------

router.get("/items", authMiddleware, isStaffMiddleware, async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
    const items = await AdminNotifications.find({})
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();
    res.json({ items });
  } catch (error) {
    console.error("Error fetching admin notifications:", error);
    res.status(500).json({ message: "Failed to fetch notifications" });
  }
});

router.get("/unread-count", authMiddleware, isStaffMiddleware, async (req, res) => {
  try {
    const count = await AdminNotifications.countDocuments({ read: false });
    res.json({ count });
  } catch (error) {
    console.error("Error fetching notification count:", error);
    res.status(500).json({ message: "Failed to fetch notification count" });
  }
});

router.patch("/:id/read", authMiddleware, isStaffMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    await AdminNotifications.updateOne(
      { _id: new ObjectId(id) },
      { $set: { read: true, readAt: new Date() } }
    );
    res.json({ message: "Notification marked as read" });
  } catch (error) {
    console.error("Error marking notification read:", error);
    res.status(500).json({ message: "Failed to update notification" });
  }
});

router.post("/campaigns", authMiddleware, isStaffMiddleware, async (req, res) => {
  try {
    const { title, body, targetAudience, scheduledAt, data } = req.body;

    if (!title || !body) {
      return res.status(400).json({ message: "Title and body are required" });
    }

    const campaign = {
      title,
      body,
      targetAudience: targetAudience || "all",
      data: data || {},
      scheduledAt: scheduledAt ? new Date(scheduledAt) : null,
      status: scheduledAt ? "scheduled" : "draft",
      sentCount: 0,
      failedCount: 0,
      createdBy: new ObjectId(req.user.userId),
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const result = await db.collection("notification_campaigns").insertOne(campaign);
    res.status(201).json({ 
      message: "Campaign created successfully",
      campaignId: result.insertedId 
    });
  } catch (error) {
    console.error("Error creating campaign:", error);
    res.status(500).json({ message: "Failed to create campaign" });
  }
});

router.post("/campaigns/:id/send", authMiddleware, isStaffMiddleware, async (req, res) => {
  try {
    const { id } = req.params;

    const campaign = await db.collection("notification_campaigns").findOne({
      _id: new ObjectId(id)
    });

    if (!campaign) {
      return res.status(404).json({ message: "Campaign not found" });
    }

    let tokenFilter = { isActive: true };
    
    if (campaign.targetAudience === "customers") {
      tokenFilter.userType = "customer";
    } else if (campaign.targetAudience === "sellers") {
      tokenFilter.userType = "seller";
    }

    const tokens = await db.collection("push_tokens")
      .find(tokenFilter)
      .project({ token: 1 })
      .toArray();

    if (tokens.length === 0) {
      return res.status(400).json({ message: "No active push tokens found for target audience" });
    }

    const tokenStrings = tokens.map(t => t.token);
    
    const batchSize = 100;
    let sentCount = 0;
    let failedCount = 0;

    for (let i = 0; i < tokenStrings.length; i += batchSize) {
      const batch = tokenStrings.slice(i, i + batchSize);
      try {
        const result = await sendExpoPushNotification(
          batch,
          campaign.title,
          campaign.body,
          campaign.data
        );
        sentCount += batch.length;
      } catch (error) {
        failedCount += batch.length;
      }
    }

    await db.collection("notification_campaigns").updateOne(
      { _id: new ObjectId(id) },
      {
        $set: {
          status: "sent",
          sentCount,
          failedCount,
          sentAt: new Date(),
          updatedAt: new Date()
        }
      }
    );

    res.json({ 
      message: "Campaign sent successfully",
      sentCount,
      failedCount
    });
  } catch (error) {
    console.error("Error sending campaign:", error);
    res.status(500).json({ message: "Failed to send campaign" });
  }
});

router.delete("/campaigns/:id", authMiddleware, isStaffMiddleware, async (req, res) => {
  try {
    const { id } = req.params;

    const campaign = await db.collection("notification_campaigns").findOne({
      _id: new ObjectId(id)
    });

    if (!campaign) {
      return res.status(404).json({ message: "Campaign not found" });
    }

    if (campaign.status === "sent") {
      return res.status(400).json({ message: "Cannot delete a sent campaign" });
    }

    await db.collection("notification_campaigns").deleteOne({
      _id: new ObjectId(id)
    });

    res.json({ message: "Campaign deleted successfully" });
  } catch (error) {
    console.error("Error deleting campaign:", error);
    res.status(500).json({ message: "Failed to delete campaign" });
  }
});

router.get("/stats", authMiddleware, isStaffMiddleware, async (req, res) => {
  try {
    const totalTokens = await db.collection("push_tokens").countDocuments({ isActive: true });
    const customerTokens = await db.collection("push_tokens").countDocuments({ 
      isActive: true, 
      userType: "customer" 
    });
    const sellerTokens = await db.collection("push_tokens").countDocuments({ 
      isActive: true, 
      userType: "seller" 
    });

    const totalCampaigns = await db.collection("notification_campaigns").countDocuments();
    const sentCampaigns = await db.collection("notification_campaigns").countDocuments({ 
      status: "sent" 
    });

    const recentCampaigns = await db.collection("notification_campaigns")
      .find({ status: "sent" })
      .sort({ sentAt: -1 })
      .limit(5)
      .toArray();

    res.json({
      tokens: {
        total: totalTokens,
        customers: customerTokens,
        sellers: sellerTokens
      },
      campaigns: {
        total: totalCampaigns,
        sent: sentCampaigns
      },
      recentCampaigns
    });
  } catch (error) {
    console.error("Error fetching notification stats:", error);
    res.status(500).json({ message: "Failed to fetch stats" });
  }
});

export default router;
