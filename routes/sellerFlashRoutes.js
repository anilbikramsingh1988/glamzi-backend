// routes/sellerFlashRoutes.js
// Seller-facing flash campaign discovery + submission for admin-created flash sales.

import express from "express";
import dotenv from "dotenv";
import { ObjectId } from "mongodb";

import { client } from "../dbConfig.js";
import {
  authMiddleware,
  isActiveMiddleware,
} from "../middlewares/authMiddleware.js";

dotenv.config();
const router = express.Router();

const dbName = process.env.DB_NAME || "glamzi_ecommerce";
const db = client.db(dbName);

const Discounts = db.collection("discounts");
const Products = db.collection("products");
const FlashEntries = db.collection("flashEntries");

const sellerGuard = [authMiddleware, isActiveMiddleware];

const toObjectId = (id) => {
  if (!id) return null;
  const s = String(id).trim();
  if (!ObjectId.isValid(s)) return null;
  try {
    return new ObjectId(s);
  } catch {
    return null;
  }
};

function normalizePricingType(t) {
  const v = String(t || "").toLowerCase();
  if (v === "percentage" || v === "percent") return "percentage";
  if (v === "fixed_price" || v === "fixed-price" || v === "flat") return "fixed_price";
  return "";
}

const toInt = (v, d = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : d;
};

// List admin-created flash campaigns (active/upcoming)
router.get("/flash-campaigns", sellerGuard, async (req, res) => {
  try {
    const now = new Date();
    const campaigns = await Discounts.find(
      {
        saleType: "flash",
        scope: { $in: [null, "product", ""] },
        $or: [{ status: "active" }, { status: "draft" }, { status: "upcoming" }],
        $and: [
          {
            $or: [
              { startAt: { $exists: false } },
              { startAt: { $lte: now } },
              { startAt: null },
            ],
          },
          {
            $or: [
              { endAt: { $exists: false } },
              { endAt: { $gte: now } },
              { endAt: null },
            ],
          },
        ],
      },
      {
        projection: {
          title: 1,
          window: 1,
          startAt: 1,
          endAt: 1,
          limits: 1,
          pricing: 1,
        },
      }
    )
      .sort({ startAt: 1 })
      .toArray();

    res.json({ success: true, items: campaigns });
  } catch (err) {
    console.error("GET /api/seller/flash-campaigns error:", err);
    res.status(500).json({ success: false, message: "Failed to load flash campaigns" });
  }
});

// Seller submissions to add a product into an admin flash campaign
router.post("/flash-entries", sellerGuard, async (req, res) => {
  try {
    const sellerId = req.user?.id || req.user?._id || req.user?.sellerId;
    if (!sellerId) return res.status(401).json({ success: false, message: "Unauthorized" });

    const campaignId = toObjectId(req.body?.campaignId);
    const productId = toObjectId(req.body?.productId);
    if (!campaignId || !productId) {
      return res.status(400).json({ success: false, message: "Invalid campaign or product id" });
    }

    const campaign = await Discounts.findOne({ _id: campaignId, saleType: "flash" });
    if (!campaign) {
      return res.status(404).json({ success: false, message: "Flash campaign not found" });
    }

    // Verify seller owns product
    const product = await Products.findOne({ _id: productId });
    if (!product) return res.status(404).json({ success: false, message: "Product not found" });
    const ownerId = String(product.sellerId || product.userId || "");
    if (ownerId !== String(sellerId)) {
      return res.status(403).json({ success: false, message: "You do not own this product" });
    }

    // Prevent duplicate pending/approved
    const existing = await FlashEntries.findOne({
      campaignId,
      productId,
      sellerId: String(sellerId),
      status: { $in: ["pending", "approved"] },
    });
    if (existing) {
      return res
        .status(409)
        .json({ success: false, message: "Already submitted for this campaign" });
    }

    const entry = {
      campaignId,
      productId,
      sellerId: String(sellerId),
      status: "pending",
      note: req.body?.note ? String(req.body.note) : null,
      limits: {
        totalQty: toInt(req.body?.totalQty, 0),
        perUserQty: toInt(req.body?.perUserQty, 0),
        perOrderQty: toInt(req.body?.perOrderQty, 0),
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const ins = await FlashEntries.insertOne(entry);
    res.json({ success: true, item: { ...entry, _id: ins.insertedId } });
  } catch (err) {
    console.error("POST /api/seller/flash-entries error:", err);
    res.status(500).json({ success: false, message: "Failed to submit flash entry" });
  }
});

// Seller view of their entries
router.get("/flash-entries", sellerGuard, async (req, res) => {
  try {
    const sellerId = req.user?.id || req.user?._id || req.user?.sellerId;
    if (!sellerId) return res.status(401).json({ success: false, message: "Unauthorized" });

    const status = req.query.status ? String(req.query.status).toLowerCase() : "";
    const filter = {
      sellerId: String(sellerId),
    };
    if (status) filter.status = status;

    const items = await FlashEntries.find(filter)
      .sort({ updatedAt: -1 })
      .limit(100)
      .toArray();

    res.json({ success: true, items });
  } catch (err) {
    console.error("GET /api/seller/flash-entries error:", err);
    res.status(500).json({ success: false, message: "Failed to load flash entries" });
  }
});

// Update limits/note for a pending entry
router.patch("/flash-entries/:id", sellerGuard, async (req, res) => {
  try {
    const sellerId = req.user?.id || req.user?._id || req.user?.sellerId;
    if (!sellerId) return res.status(401).json({ success: false, message: "Unauthorized" });

    const id = toObjectId(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: "Invalid entry id" });

    const entry = await FlashEntries.findOne({ _id: id, sellerId: String(sellerId) });
    if (!entry) return res.status(404).json({ success: false, message: "Entry not found" });
    if (entry.status !== "pending") {
      return res.status(400).json({ success: false, message: "Only pending entries can be edited" });
    }

    const limits = {
      totalQty: toInt(req.body?.limits?.totalQty ?? req.body?.totalQty, entry?.limits?.totalQty ?? 0),
      perUserQty: toInt(
        req.body?.limits?.perUserQty ?? req.body?.perUserQty,
        entry?.limits?.perUserQty ?? 0
      ),
      perOrderQty: toInt(
        req.body?.limits?.perOrderQty ?? req.body?.perOrderQty,
        entry?.limits?.perOrderQty ?? 0
      ),
    };

    const note = req.body?.note !== undefined ? String(req.body.note || "") : entry.note || null;

    const update = {
      limits,
      note,
      updatedAt: new Date(),
    };

    const result = await FlashEntries.findOneAndUpdate(
      { _id: id },
      { $set: update },
      { returnDocument: "after" }
    );

    res.json({ success: true, item: result.value });
  } catch (err) {
    console.error("PATCH /api/seller/flash-entries/:id error:", err);
    res.status(500).json({ success: false, message: "Failed to update flash entry" });
  }
});

// Delete a seller flash entry (pending only)
router.delete("/flash-entries/:id", sellerGuard, async (req, res) => {
  try {
    const sellerId = req.user?.id || req.user?._id || req.user?.sellerId;
    if (!sellerId) return res.status(401).json({ success: false, message: "Unauthorized" });

    const id = toObjectId(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: "Invalid entry id" });

    const entry = await FlashEntries.findOne({ _id: id, sellerId: String(sellerId) });
    if (!entry) return res.status(404).json({ success: false, message: "Entry not found" });
    if (entry.status !== "pending") {
      return res.status(400).json({ success: false, message: "Only pending entries can be removed" });
    }

    await FlashEntries.deleteOne({ _id: id });
    res.json({ success: true, deleted: 1 });
  } catch (err) {
    console.error("DELETE /api/seller/flash-entries/:id error:", err);
    res.status(500).json({ success: false, message: "Failed to delete flash entry" });
  }
});

export default router;
