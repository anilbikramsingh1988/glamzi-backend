import express from "express";
import { ObjectId } from "mongodb";
import dotenv from "dotenv";

import { client } from "../dbConfig.js";
import { authMiddleware } from "../middlewares/authMiddleware.js";

dotenv.config();

const router = express.Router();

const dbName = process.env.DB_NAME || "glamzi_ecommerce";
const db = client.db(dbName);
const StoreReviews = db.collection("storeReviews");
const Orders = db.collection("orders");

const toObjectId = (id) => {
  if (!id) return null;
  try {
    if (ObjectId.isValid(id) && String(new ObjectId(id)) === String(id)) {
      return new ObjectId(id);
    }
    return null;
  } catch {
    return null;
  }
};

const buildSellerMatch = (sellerId) => {
  const sellerObjectId = toObjectId(sellerId);
  if (sellerObjectId) {
    return { $or: [{ sellerId: sellerObjectId }, { sellerId: String(sellerId) }] };
  }
  return { sellerId: String(sellerId) };
};

router.post("/", authMiddleware, async (req, res) => {
  try {
    const user = req.user;
    if (!user || user.role !== "customer") {
      return res.status(403).json({ message: "Only customers can review stores" });
    }

    const { sellerId, rating, comment } = req.body;

    if (!sellerId || !rating) {
      return res.status(400).json({ message: "sellerId and rating are required" });
    }

    const sellerObjectId = toObjectId(sellerId);
    if (!sellerObjectId) {
      return res.status(400).json({ message: "Invalid sellerId" });
    }

    if (String(user.id) === String(sellerId)) {
      return res.status(400).json({ message: "You cannot review your own store" });
    }

    const numericRating = Number(rating);
    if (!Number.isFinite(numericRating) || numericRating < 1 || numericRating > 5) {
      return res.status(400).json({ message: "Rating must be between 1 and 5" });
    }

    const customerObjectId = toObjectId(user.id);
    const customerIdQuery = customerObjectId 
      ? { $or: [{ customerId: customerObjectId }, { customerId: String(user.id) }] }
      : { customerId: String(user.id) };

    const existing = await StoreReviews.findOne({
      ...buildSellerMatch(sellerId).valueOf(),
      ...customerIdQuery,
    });

    if (existing) {
      return res.status(400).json({ message: "You have already reviewed this store" });
    }

    const now = new Date();

    const doc = {
      sellerId: sellerObjectId,
      customerId: customerObjectId || String(user.id),
      customerName: user.name || user.fullName || user.email || "Customer",
      rating: numericRating,
      comment: comment?.trim() || "",
      status: "approved",
      createdAt: now,
      updatedAt: now,
    };

    const result = await StoreReviews.insertOne(doc);

    return res.status(201).json({
      message: "Store review submitted",
      review: { ...doc, _id: result.insertedId },
    });
  } catch (err) {
    console.error("Error creating store review:", err);
    return res.status(500).json({ message: "Failed to create store review" });
  }
});

router.get("/store/:sellerId", async (req, res) => {
  try {
    const { sellerId } = req.params;
    const sellerObjectId = toObjectId(sellerId);
    
    const sellerMatch = sellerObjectId 
      ? { $or: [{ sellerId: sellerObjectId }, { sellerId: String(sellerId) }] }
      : { sellerId: String(sellerId) };

    const reviews = await StoreReviews.find({
      ...sellerMatch,
      status: "approved",
    })
      .sort({ createdAt: -1 })
      .toArray();

    return res.json({ reviews });
  } catch (err) {
    console.error("Error fetching store reviews:", err);
    return res.status(500).json({ message: "Failed to fetch store reviews" });
  }
});

router.get("/stats/:sellerId", async (req, res) => {
  try {
    const { sellerId } = req.params;
    const sellerObjectId = toObjectId(sellerId);
    
    const sellerMatch = sellerObjectId 
      ? { $or: [{ sellerId: sellerObjectId }, { sellerId: String(sellerId) }] }
      : { sellerId: String(sellerId) };

    const pipeline = [
      {
        $match: {
          ...sellerMatch,
          status: "approved",
        },
      },
      {
        $group: {
          _id: "$rating",
          count: { $sum: 1 },
        },
      },
    ];

    const buckets = await StoreReviews.aggregate(pipeline).toArray();

    let totalReviews = 0;
    let sumRating = 0;
    const distribution = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };

    buckets.forEach((b) => {
      const r = Number(b._id);
      const c = Number(b.count) || 0;
      if (r >= 1 && r <= 5) {
        distribution[r] = c;
        totalReviews += c;
        sumRating += r * c;
      }
    });

    const averageRating = totalReviews > 0 ? sumRating / totalReviews : 0;

    return res.json({
      averageRating,
      totalReviews,
      distribution,
    });
  } catch (err) {
    console.error("Error fetching store review stats:", err);
    return res.status(500).json({ message: "Failed to fetch store review stats" });
  }
});

router.get("/monthly-sales/:sellerId", async (req, res) => {
  try {
    const { sellerId } = req.params;
    const sellerObjectId = toObjectId(sellerId);

    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const sellerMatchConditions = sellerObjectId
      ? [{ "items.sellerId": sellerObjectId }, { "items.sellerId": String(sellerId) }]
      : [{ "items.sellerId": String(sellerId) }];

    const pipeline = [
      {
        $match: {
          $or: sellerMatchConditions,
          createdAt: { $gte: startOfMonth },
          status: { $nin: ["cancelled", "refunded"] },
        },
      },
      { $unwind: "$items" },
      {
        $match: sellerObjectId
          ? { $or: [{ "items.sellerId": sellerObjectId }, { "items.sellerId": String(sellerId) }] }
          : { "items.sellerId": String(sellerId) },
      },
      {
        $group: {
          _id: null,
          totalItems: { $sum: "$items.quantity" },
        },
      },
    ];

    const result = await Orders.aggregate(pipeline).toArray();
    const monthlySales = result[0]?.totalItems || 0;

    return res.json({ monthlySales });
  } catch (err) {
    console.error("Error fetching monthly sales:", err);
    return res.status(500).json({ message: "Failed to fetch monthly sales" });
  }
});

export default router;
