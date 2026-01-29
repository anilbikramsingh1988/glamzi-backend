import express from "express";
import dotenv from "dotenv";

import { client } from "../dbConfig.js";
import { authMiddleware } from "../middlewares/authMiddleware.js";

dotenv.config();

const router = express.Router();

const getSubscribersCollection = () => {
  const dbName = process.env.DB_NAME || "glamzi";
  return client.db(dbName).collection("subscribers");
};

/**
 * GET /api/admin/subscribers
 * List subscribers for Admin UI
 * Optional query params: search, page, limit
 */
router.get("/subscribers", authMiddleware, async (req, res) => {
  try {
    const subscribers = getSubscribersCollection();
    const { search = "", page = 1, limit = 20 } = req.query;

    const pageNum = Number(page) || 1;
    const limitNum = Number(limit) || 20;
    const skip = (pageNum - 1) * limitNum;

    const filter = {};
    if (search && String(search).trim()) {
      const regex = new RegExp(String(search).trim(), "i");
      filter.$or = [{ email: regex }, { source: regex }];
    }

    const [items, total] = await Promise.all([
      subscribers
        .find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .toArray(),
      subscribers.countDocuments(filter),
    ]);

    res.json({
      items,
      total,
      page: pageNum,
      limit: limitNum,
      totalPages: Math.ceil(total / limitNum),
    });
  } catch (err) {
    console.error("❌ Error fetching subscribers:", err);
    res.status(500).json({ message: "Failed to fetch subscribers" });
  }
});

export default router;
