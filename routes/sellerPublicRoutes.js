// routes/sellerPublicRoutes.js
import express from "express";
import { ObjectId } from "mongodb";
import { client } from "../dbConfig.js";

const router = express.Router();
const db = client.db("glamzi_ecommerce");

// ✅ Correct collections
const Sellers = db.collection("sellers");
const Users = db.collection("users");
const Products = db.collection("products");
const Reviews = db.collection("reviews");
const SellerSettings = db.collection("seller_settings");
const SellerSettingsLegacy = db.collection("sellerSettings");

function buildSellerIdFilters(sellerIdStr) {
  const filters = [];
  if (!sellerIdStr) return filters;

  filters.push({ sellerId: sellerIdStr }, { userId: sellerIdStr });

  if (ObjectId.isValid(sellerIdStr)) {
    const oid = new ObjectId(sellerIdStr);
    filters.push({ sellerId: oid }, { userId: oid }, { ownerId: oid });
  }

  return filters;
}

/**
 * GET /api/sellers/public/:sellerId
 * Public seller profile for product pages & store page header
 */
router.get("/public/:sellerId", async (req, res) => {
  try {
    const { sellerId } = req.params;

    const sellerIdStr = String(sellerId || "").trim();
    const sellerObjectId = ObjectId.isValid(sellerIdStr)
      ? new ObjectId(sellerIdStr)
      : null;

    // 🔍 Load seller from `sellers` collection
    let seller = await Sellers.findOne(
      sellerObjectId ? { _id: sellerObjectId } : { sellerId: sellerIdStr },
      {
        projection: {
          // identity / names
          ownerFirstName: 1,
          ownerLastName: 1,
          firstName: 1,
          lastName: 1,
          name: 1,
          storeName: 1,
          shopName: 1,

          // contact / support
          phone: 1,
          email: 1,
          supportEmail: 1,
          supportPhone: 1,
          supportWhatsapp: 1,

          // location
          tole: 1,
          wardNumber: 1,
          municipalityName: 1,
          district: 1,
          province: 1,
          streetAddress: 1,
          location: 1, // in case you add a raw string later

          // meta
          logoUrl: 1,
          createdAt: 1,
          rating: 1,
          ratingCount: 1,
          isVerifiedSeller: 1,
          verified: 1,
          defaultCountry: 1,
          defaultCurrency: 1,
          timezone: 1,
          language: 1,
          description: 1,
          storeDescription: 1,
          seoTitle: 1,
          seoDescription: 1,
        },
      }
    );
    if (!seller) {
      seller = await Users.findOne(
        sellerObjectId ? { _id: sellerObjectId } : { sellerId: sellerIdStr },
        {
          projection: {
            // identity / names
            ownerFirstName: 1,
            ownerLastName: 1,
            firstName: 1,
            lastName: 1,
            name: 1,
            storeName: 1,
            shopName: 1,

            // contact / support
            phone: 1,
            email: 1,
            supportEmail: 1,
            supportPhone: 1,
            supportWhatsapp: 1,

            // location
            tole: 1,
            wardNumber: 1,
            municipalityName: 1,
            district: 1,
            province: 1,
            streetAddress: 1,
            location: 1,

          // meta
          logoUrl: 1,
          createdAt: 1,
          rating: 1,
          ratingCount: 1,
          isVerifiedSeller: 1,
          verified: 1,
          defaultCountry: 1,
          defaultCurrency: 1,
          timezone: 1,
          language: 1,
          description: 1,
          storeDescription: 1,
          seoTitle: 1,
          seoDescription: 1,
        },
      }
    );
    }

    if (!seller) {
      console.warn("⚠️ Seller not found for public store:", sellerId);
      return res.status(404).json({ message: "Seller not found" });
    }

    // 🗺️ Build a nice human-readable location
    const locationParts = [
      seller.tole,
      seller.municipalityName,
      seller.district,
      seller.province,
    ].filter(Boolean);

    const derivedLocation =
      locationParts.length > 0
        ? locationParts.join(", ")
        : seller.location || "Nepal";

    // 🛍️ Count products for this seller
    // (we support both userId and sellerId fields in products)
    const sellerMatchValues = [sellerIdStr].filter(Boolean);
    if (sellerObjectId) sellerMatchValues.push(sellerObjectId);
    const totalProducts = await Products.countDocuments({
      $or: [
        { userId: { $in: sellerMatchValues } },
        { sellerId: { $in: sellerMatchValues } },
      ],
    });

    const totalOrders = seller.totalOrders || 0;

    // 👤 Owner name
    const ownerName =
      (seller.ownerFirstName || seller.firstName || "") ||
      (seller.ownerLastName || seller.lastName || "")
        ? `${seller.ownerFirstName || seller.firstName || ""} ${
            seller.ownerLastName || seller.lastName || ""
          }`.trim()
        : seller.name;

    // 🎯 Response shape expected by frontend
    return res.json({
      seller: {
        _id: seller._id,
        storeName: seller.storeName || seller.shopName || "Store",
        ownerName: ownerName || undefined,
        logoUrl: seller.logoUrl || null,
        location: derivedLocation,
        province: seller.province || null,
        createdAt: seller.createdAt,
        rating: typeof seller.rating === "number" ? seller.rating : 4.8,
        ratingCount: seller.ratingCount || 0,
        totalProducts,
        totalOrders,
        isVerifiedSeller: !!(seller.isVerifiedSeller || seller.verified),
        verified: !!seller.verified,
        supportEmail: seller.supportEmail || null,
        supportPhone: seller.supportPhone || null,
        defaultCountry: seller.defaultCountry || "Nepal",
        defaultCurrency: seller.defaultCurrency || "NPR",
        timezone: seller.timezone || "Asia/Kathmandu",
        language: seller.language || "en",
        description: seller.description || seller.storeDescription || "",
        seoTitle: seller.seoTitle || "",
        seoDescription: seller.seoDescription || "",
      },
    });
  } catch (err) {
    console.error("GET /sellers/public error:", err);
    res.status(500).json({ message: "Failed to load seller data" });
  }
});

/**
 * GET /api/sellers/public/:sellerId/products
 * Products for a given seller – used by StorePage grid
 */
router.get("/public/:sellerId/products", async (req, res) => {
  try {
    const { sellerId } = req.params;

    const sellerIdStr = String(sellerId || "").trim();
    const sellerObjectId = ObjectId.isValid(sellerIdStr)
      ? new ObjectId(sellerIdStr)
      : null;

    const products = await Products.find(
      {
        $or: [
          ...(sellerObjectId ? [{ userId: sellerObjectId }, { sellerId: sellerObjectId }] : []),
          ...(sellerIdStr ? [{ userId: sellerIdStr }, { sellerId: sellerIdStr }] : []),
        ],
        status: { $ne: "inactive" },
        deleted: { $ne: true },
      },
      {
        projection: {
          title: 1,
          price: 1,
          oldPrice: 1,
          images: 1,
          image: 1,
          featuredImage: 1,
          sellerId: 1,
          userId: 1,
          category: 1,
          brand: 1,
          createdAt: 1,
          soldCount: 1,
          quantity: 1,
          description: 1,
        },
      }
    )
      .sort({ createdAt: -1 })
      .toArray();

    // Calculate ratings from reviews collection (productId stored as ObjectId)
    const productIds = products.map((p) => p._id);
    const ratingStats = await Reviews.aggregate([
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

    // Attach rating stats to products
    const enrichedProducts = products.map((p) => {
      const stats = statsMap[p._id.toString()] || { averageRating: 0, totalReviews: 0 };
      return {
        ...p,
        rating: stats.averageRating,
        reviewCount: stats.totalReviews,
      };
    });

    return res.json({ products: enrichedProducts });
  } catch (err) {
    console.error("GET /sellers/public/:sellerId/products error:", err);
    res.status(500).json({ message: "Failed to load seller products" });
  }
});

/**
 * GET /api/sellers/public/:sellerId/shipping
 * Public shipping settings for product/detail delivery info
 */
router.get("/public/:sellerId/shipping", async (req, res) => {
  try {
    const { sellerId } = req.params;
    const sellerIdStr = String(sellerId || "").trim();
    const filters = buildSellerIdFilters(sellerIdStr);
    if (!filters.length || sellerIdStr === "undefined" || sellerIdStr === "null") {
      return res.json({ settings: {} });
    }

    let settings = await SellerSettings.findOne({ $or: filters });
    if (!settings) {
      settings = await SellerSettingsLegacy.findOne({ $or: filters });
    }

    res.set("Cache-Control", "no-store");
    return res.json({ settings: settings?.shipping || {} });
  } catch (err) {
    console.error("GET /sellers/public/:sellerId/shipping error:", err);
    return res.status(500).json({ message: "Failed to load shipping settings" });
  }
});

export default router;











