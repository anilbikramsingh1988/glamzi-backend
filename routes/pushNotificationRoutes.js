import express from "express";
import { ObjectId } from "mongodb";
import { client } from "../dbConfig.js";
import { authMiddleware } from "../middlewares/authMiddleware.js";

const router = express.Router();
const db = client.db(process.env.DB_NAME || "glamzi_ecommerce");

router.post("/register-token", authMiddleware, async (req, res) => {
  try {
    const { token, platform, deviceId } = req.body;
    const userId = req.user.userId;
    const userType = req.user.role || "customer";

    if (!token) {
      return res.status(400).json({ message: "Push token is required" });
    }

    await db.collection("push_tokens").updateOne(
      { 
        userId: new ObjectId(userId),
        deviceId: deviceId || token.substring(0, 50)
      },
      {
        $set: {
          token,
          platform: platform || "unknown",
          userType,
          isActive: true,
          updatedAt: new Date()
        },
        $setOnInsert: {
          createdAt: new Date()
        }
      },
      { upsert: true }
    );

    res.json({ message: "Push token registered successfully" });
  } catch (error) {
    console.error("Error registering push token:", error);
    res.status(500).json({ message: "Failed to register push token" });
  }
});

router.delete("/unregister-token", authMiddleware, async (req, res) => {
  try {
    const { token, deviceId } = req.body;
    const userId = req.user.userId;

    await db.collection("push_tokens").updateOne(
      { 
        userId: new ObjectId(userId),
        $or: [
          { token },
          { deviceId }
        ]
      },
      { $set: { isActive: false, updatedAt: new Date() } }
    );

    res.json({ message: "Push token unregistered successfully" });
  } catch (error) {
    console.error("Error unregistering push token:", error);
    res.status(500).json({ message: "Failed to unregister push token" });
  }
});

router.get("/preferences", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;

    const preferences = await db.collection("notification_preferences").findOne({
      userId: new ObjectId(userId)
    });

    const defaultPrefs = {
      orderUpdates: true,
      promotions: true,
      newMessages: true,
      priceDrops: true,
      lowStock: true,
      newOrders: true
    };

    res.json({ preferences: preferences?.settings || defaultPrefs });
  } catch (error) {
    console.error("Error fetching notification preferences:", error);
    res.status(500).json({ message: "Failed to fetch preferences" });
  }
});

router.put("/preferences", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { preferences } = req.body;

    await db.collection("notification_preferences").updateOne(
      { userId: new ObjectId(userId) },
      {
        $set: {
          settings: preferences,
          updatedAt: new Date()
        },
        $setOnInsert: { createdAt: new Date() }
      },
      { upsert: true }
    );

    res.json({ message: "Preferences updated successfully" });
  } catch (error) {
    console.error("Error updating preferences:", error);
    res.status(500).json({ message: "Failed to update preferences" });
  }
});

export default router;
