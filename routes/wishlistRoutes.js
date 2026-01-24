import express from "express";
import { ObjectId } from "mongodb";
import { client } from "../dbConfig.js";
import { authMiddleware } from "../middlewares/authMiddleware.js";

const router = express.Router();
const db = client.db(process.env.DB_NAME || "glamzi_ecommerce");

function getCustomerId(req) {
  return String(req.user?.id || req.user?._id || req.user?.userId || "");
}

function getCustomerFilter(customerId) {
  const filters = [{ customerId }, { userId: customerId }];
  if (ObjectId.isValid(customerId)) {
    filters.push(
      { customerId: new ObjectId(customerId) },
      { userId: new ObjectId(customerId) }
    );
  }
  return { $or: filters };
}

router.get("/", authMiddleware, async (req, res) => {
  try {
    const customerId = getCustomerId(req);
    if (!customerId) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    
    const wishlist = await db.collection("wishlists").findOne({
      ...getCustomerFilter(customerId)
    });

    if (!wishlist || !wishlist.products || wishlist.products.length === 0) {
      return res.json({ products: [] });
    }

    const rawIds = wishlist.products.map((item) => item?.productId || item);
    const productIds = rawIds
      .filter((id) => ObjectId.isValid(id))
      .map((id) => new ObjectId(id));

    if (productIds.length === 0) {
      return res.json({ products: [] });
    }
    const products = await db.collection("products").aggregate([
      { $match: { _id: { $in: productIds } } },
      {
        $addFields: {
          stock: { $ifNull: ["$stock", { $ifNull: ["$inventory.quantity", "$quantity"] }] },
          averageRating: { $ifNull: ["$averageRating", "$rating"] },
          reviewCount: { $ifNull: ["$reviewCount", "$numReviews"] }
        }
      },
      {
        $lookup: {
          from: "sellers",
          localField: "sellerId",
          foreignField: "_id",
          as: "seller"
        }
      },
      { $unwind: { path: "$seller", preserveNullAndEmptyArrays: true } },
      {
        $project: {
          _id: 1,
          title: 1,
          price: 1,
          salePrice: 1,
          compareAtPrice: 1,
          quantity: 1,
          images: 1,
          stock: 1,
          soldCount: 1,
          averageRating: 1,
          reviewCount: 1,
          "seller.storeName": 1,
          "seller._id": 1
        }
      }
    ]).toArray();

    const ratingStats = await db.collection("reviews").aggregate([
      {
        $match: {
          productId: { $in: productIds },
          status: "approved",
        },
      },
      {
        $group: {
          _id: "$productId",
          averageRating: { $avg: "$rating" },
          totalReviews: { $sum: 1 },
        },
      },
    ]).toArray();

    const statsMap = {};
    for (const stat of ratingStats) {
      statsMap[stat._id.toString()] = {
        averageRating: stat.averageRating || 0,
        totalReviews: stat.totalReviews || 0,
      };
    }

    const enrichedProducts = products.map((item) => {
      const stats = statsMap[item._id.toString()];
      if (!stats) return item;
      return {
        ...item,
        averageRating: stats.averageRating,
        reviewCount: stats.totalReviews,
      };
    });

    res.json({ products: enrichedProducts });
  } catch (error) {
    console.error("Error fetching wishlist:", error);
    res.status(500).json({ message: "Failed to fetch wishlist" });
  }
});

router.post("/add", authMiddleware, async (req, res) => {
  try {
    const customerId = getCustomerId(req);
    if (!customerId) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    const { productId } = req.body;

    if (!productId) {
      return res.status(400).json({ message: "Product ID is required" });
    }

    if (!ObjectId.isValid(productId)) {
      return res.status(400).json({ message: "Invalid product ID" });
    }

    const product = await db.collection("products").findOne({
      _id: new ObjectId(productId)
    });

    if (!product) {
      return res.status(404).json({ message: "Product not found" });
    }

    const customerIdValue = ObjectId.isValid(customerId)
      ? new ObjectId(customerId)
      : customerId;

    await db.collection("wishlists").updateOne(
      getCustomerFilter(customerId),
      { 
        $addToSet: { products: new ObjectId(productId) },
        $set: { updatedAt: new Date() },
        $setOnInsert: {
          createdAt: new Date(),
          customerId: customerIdValue,
          userId: customerId
        }
      },
      { upsert: true }
    );
    const updated = await db.collection("wishlists").findOne({
      ...getCustomerFilter(customerId)
    });

    res.json({ message: "Product added to wishlist", productId });
  } catch (error) {
    console.error("Error adding to wishlist:", error);
    res.status(500).json({ message: "Failed to add to wishlist" });
  }
});

router.delete("/remove/:productId", authMiddleware, async (req, res) => {
  try {
    const customerId = getCustomerId(req);
    if (!customerId) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    const { productId } = req.params;

    await db.collection("wishlists").updateOne(
      getCustomerFilter(customerId),
      { 
        $pull: { products: new ObjectId(productId) },
        $set: { updatedAt: new Date() }
      }
    );

    res.json({ message: "Product removed from wishlist", productId });
  } catch (error) {
    console.error("Error removing from wishlist:", error);
    res.status(500).json({ message: "Failed to remove from wishlist" });
  }
});

router.get("/check/:productId", authMiddleware, async (req, res) => {
  try {
    const customerId = getCustomerId(req);
    if (!customerId) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    const { productId } = req.params;

    const wishlist = await db.collection("wishlists").findOne({
      ...getCustomerFilter(customerId),
      products: new ObjectId(productId)
    });

    res.json({ inWishlist: !!wishlist });
  } catch (error) {
    console.error("Error checking wishlist:", error);
    res.status(500).json({ message: "Failed to check wishlist" });
  }
});

router.get("/count", authMiddleware, async (req, res) => {
  try {
    const customerId = getCustomerId(req);
    if (!customerId) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    
    const wishlist = await db.collection("wishlists").findOne({
      ...getCustomerFilter(customerId)
    });

    const count = wishlist?.products?.length || 0;
    res.json({ count });
  } catch (error) {
    console.error("Error getting wishlist count:", error);
    res.status(500).json({ message: "Failed to get wishlist count" });
  }
});

export default router;
