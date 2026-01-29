import express from "express";
import dotenv from "dotenv";

import { client } from "../dbConfig.js";

dotenv.config();

const router = express.Router();

const getSubscribersCollection = () => {
  const dbName = process.env.DB_NAME || "glamzi";
  return client.db(dbName).collection("subscribers");
};

const normalizeEmail = (value) =>
  String(value || "").trim().toLowerCase();

const isValidEmail = (value) =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

/**
 * POST /api/subscribers
 * Public endpoint to store newsletter subscribers.
 */
router.post("/subscribers", async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    if (!email || !isValidEmail(email)) {
      return res.status(400).json({ message: "Valid email is required" });
    }

    const source = String(req.body?.source || "footer").trim();
    const consent = Boolean(req.body?.consent ?? true);
    const now = new Date();
    const userAgent = String(req.headers["user-agent"] || "");
    const ip =
      String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
      req.ip ||
      "";

    const subscribers = getSubscribersCollection();

    await subscribers.updateOne(
      { email },
      {
        $set: {
          email,
          source,
          consent,
          userAgent,
          ip,
          updatedAt: now,
        },
        $setOnInsert: { createdAt: now },
      },
      { upsert: true }
    );

    res.json({ success: true, email });
  } catch (err) {
    console.error("❌ Error saving subscriber:", err);
    res.status(500).json({ message: "Failed to save subscriber" });
  }
});

export default router;
