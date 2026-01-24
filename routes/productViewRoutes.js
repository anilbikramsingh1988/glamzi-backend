// routes/productViewRoutes.js
import express from "express";
import { ObjectId } from "mongodb";
import { client } from "../dbConfig.js";
import { authMiddleware } from "../middlewares/authMiddleware.js";

const router = express.Router();

const db = client.db("glamzi_ecommerce");
const ProductViews = db.collection("productViews");

/**
 * POST /api/track/product-view
 * Body: { productId, sellerId, title, imageUrl, price }
 * Requires: logged-in user (customer)
 */
router.post("/product-view", authMiddleware, async (req, res) => {
  try {
    const user = req.user;
    const customerId = user?._id?.toString() || user?.id?.toString();

    if (!customerId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const { productId, sellerId, title, imageUrl, price } = req.body;

    if (!productId || !sellerId) {
      return res
        .status(400)
        .json({ message: "productId and sellerId are required" });
    }

    const now = new Date();

    // Upsert last viewed record for this (seller, customer, product)
    await ProductViews.updateOne(
      {
        sellerId: sellerId.toString(),
        customerId: customerId.toString(),
        productId: productId.toString(),
      },
      {
        $set: {
          sellerId: sellerId.toString(),
          customerId: customerId.toString(),
          productId: productId.toString(),
          title: title || "",
          imageUrl: imageUrl || "",
          price: typeof price === "number" ? price : Number(price) || 0,
          viewedAt: now,
          updatedAt: now,
        },
        $setOnInsert: {
          createdAt: now,
        },
      },
      { upsert: true }
    );

    return res.json({ success: true });
  } catch (err) {
    console.error("Error in POST /track/product-view:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

export default router;
