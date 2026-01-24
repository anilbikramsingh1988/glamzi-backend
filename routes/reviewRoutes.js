// routes/reviewRoutes.js
import express from "express";
import { ObjectId } from "mongodb";
import dotenv from "dotenv";

import { client } from "../dbConfig.js";
import { authMiddleware } from "../middlewares/authMiddleware.js";

dotenv.config();

const router = express.Router();

const dbName = process.env.DB_NAME || "glamzi_ecommerce";
const db = client.db(dbName);
const Reviews = db.collection("reviews");

// ===== Helper to validate ObjectId =====
const toObjectId = (id) => {
  try {
    return new ObjectId(id);
  } catch {
    return null;
  }
};

/* ---------------------------------------------------------
   POST /api/reviews
   ↳ Create a new review for a product (customer only)
---------------------------------------------------------- */
router.post("/", authMiddleware, async (req, res) => {
  try {
    const user = req.user; // from authMiddleware
    if (!user || user.role !== "customer") {
      return res.status(403).json({ message: "Only customers can post reviews" });
    }

    const { productId, rating, title, comment } = req.body;

    if (!productId || !rating) {
      return res.status(400).json({ message: "productId and rating are required" });
    }

    const productObjectId = toObjectId(productId);
    if (!productObjectId) {
      return res.status(400).json({ message: "Invalid productId" });
    }

    const numericRating = Number(rating);
    if (!Number.isFinite(numericRating) || numericRating < 1 || numericRating > 5) {
      return res.status(400).json({ message: "Rating must be between 1 and 5" });
    }

    // Optional: one review per customer per product
    const existing = await Reviews.findOne({
      productId: productObjectId,
      customerId: new ObjectId(user.id),
    });

    if (existing) {
      return res
        .status(400)
        .json({ message: "You have already reviewed this product" });
    }

    const now = new Date();

    const doc = {
      productId: productObjectId,
      customerId: new ObjectId(user.id),
      customerName: user.name || user.fullName || user.email || "Customer",
      rating: numericRating,
      title: title?.trim() || "",
      comment: comment?.trim() || "",
      status: "approved", // later you can change to "pending"
      createdAt: now,
      updatedAt: now,
    };

    const result = await Reviews.insertOne(doc);

    return res.status(201).json({
      message: "Review submitted",
      review: { ...doc, _id: result.insertedId },
    });
  } catch (err) {
    console.error("Error creating review:", err);
    return res.status(500).json({ message: "Failed to create review" });
  }
});

/* ---------------------------------------------------------
   GET /api/reviews/product/:productId
   ↳ List approved reviews for a product
---------------------------------------------------------- */
router.get("/product/:productId", async (req, res) => {
  try {
    const { productId } = req.params;
    const productObjectId = toObjectId(productId);
    if (!productObjectId) {
      return res.status(400).json({ message: "Invalid productId" });
    }

    const reviews = await Reviews.find({
      productId: productObjectId,
      status: "approved",
    })
      .sort({ createdAt: -1 })
      .toArray();

    return res.json({ reviews });
  } catch (err) {
    console.error("Error fetching product reviews:", err);
    return res.status(500).json({ message: "Failed to fetch reviews" });
  }
});

/* ---------------------------------------------------------
   GET /api/reviews/stats/:productId
   ↳ Aggregate stats for Ratings & Reviews summary
---------------------------------------------------------- */
router.get("/stats/:productId", async (req, res) => {
  try {
    const { productId } = req.params;
    const productObjectId = toObjectId(productId);
    if (!productObjectId) {
      return res.status(400).json({ message: "Invalid productId" });
    }

    const pipeline = [
      {
        $match: {
          productId: productObjectId,
          status: "approved",
        },
      },
      {
        $group: {
          _id: "$rating",
          count: { $sum: 1 },
          total: { $sum: "$rating" },
        },
      },
    ];

    const buckets = await Reviews.aggregate(pipeline).toArray();

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

    const averageRating =
      totalReviews > 0 ? sumRating / totalReviews : 0;

    return res.json({
      averageRating,
      totalReviews,
      distribution,
    });
  } catch (err) {
    console.error("Error fetching review stats:", err);
    return res.status(500).json({ message: "Failed to fetch review stats" });
  }
});

export default router;
