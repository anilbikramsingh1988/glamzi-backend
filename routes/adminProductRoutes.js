// routes/adminProductRoutes.js
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

// ====== DB SETUP ======
const dbName = process.env.DB_NAME || "glamzi_ecommerce";
const db = client.db(dbName);
const Products = db.collection("products");
const Users = db.collection("users");
const Orders = db.collection("orders");

// =====================================================
// Helpers
// =====================================================
function ensureAdminOrSuper(req, res) {
  const role = (req.user?.role || "").toLowerCase();
  if (role !== "admin" && role !== "super-admin") {
    res.status(403).json({ message: "Admin or Super Admin only" });
    return false;
  }
  return true;
}

function ensureObjectId(id) {
  try {
    return new ObjectId(id);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------
   GET /api/admin/products
   ↳ List products for review with filters + inventory enrichment
------------------------------------------------------------------- */
router.get(
  "/products",
  authMiddleware,
  isActiveMiddleware,
  async (req, res) => {
    try {
      if (!ensureAdminOrSuper(req, res)) return;

      const {
        page = 1,
        limit = 20,
        status,
        search,
      } = req.query;

      const pageNum = Math.max(parseInt(page, 10) || 1, 1);
      const limitNum = Math.max(parseInt(limit, 10) || 20, 1);

      const filter = { deleted: { $ne: true } };

      if (status && ["approved", "pending", "rejected"].includes(status)) {
        filter.status = status;
      }

      if (search && search.trim()) {
        const regex = new RegExp(search.trim(), "i");
        filter.$or = [
          { title: regex },
          { name: regex },
          { barcode: regex },
          { category: regex },
        ];
      }

      const total = await Products.countDocuments(filter);

      // Use aggregation to enrich products with seller info and sold quantities
      const pipeline = [
        { $match: filter },
        { $sort: { createdAt: -1 } },
        { $skip: (pageNum - 1) * limitNum },
        { $limit: limitNum },
        // Convert sellerId/userId to ObjectId for lookup (handle string IDs)
        {
          $addFields: {
            sellerIdRaw: { $ifNull: ["$sellerId", "$userId"] },
            sellerObjId: {
              $convert: {
                input: { $ifNull: ["$sellerId", "$userId"] },
                to: "objectId",
                onError: null,
                onNull: null,
              },
            },
            // Normalize stock/quantity field early
            _stock: {
              $convert: {
                input: { $ifNull: ["$stock", { $ifNull: ["$quantity", { $ifNull: ["$availableQty", 0] }] }] },
                to: "int",
                onError: 0,
                onNull: 0,
              },
            },
          },
        },
        // Lookup seller/user info by ObjectId
        {
          $lookup: {
            from: "users",
            localField: "sellerObjId",
            foreignField: "_id",
            as: "sellerInfo",
          },
        },
        { $unwind: { path: "$sellerInfo", preserveNullAndEmptyArrays: true } },
        // Add seller name and inventory fields
        {
          $addFields: {
            storeName: {
              $ifNull: [
                "$sellerInfo.storeName",
                { $ifNull: ["$sellerInfo.shopName", { $ifNull: ["$sellerInfo.name", "$sellerInfo.email"] }] },
              ],
            },
            sellerStoreName: {
              $ifNull: [
                "$sellerInfo.storeName",
                { $ifNull: ["$sellerInfo.shopName", { $ifNull: ["$sellerInfo.name", "$sellerInfo.email"] }] },
              ],
            },
            // Finalize stock/quantity
            stock: "$_stock",
            quantity: "$_stock",
          },
        },
        // Clean up temporary fields
        {
          $project: {
            sellerObjId: 0,
            sellerIdRaw: 0,
            sellerInfo: 0,
            _stock: 0,
          },
        },
      ];

      const products = await Products.aggregate(pipeline).toArray();

      // Get sold quantities from orders (aggregate per product)
      // Handle both ObjectId and string productId in orders
      const productIds = products.map((p) => p._id);
      const productIdStrings = productIds.map((id) => id.toString());
      
      const soldAgg = await Orders.aggregate([
        {
          $match: {
            status: { $in: ["delivered", "completed", "shipped", "processing"] },
          },
        },
        { $unwind: "$items" },
        {
          $addFields: {
            "items.productIdStr": { $toString: "$items.productId" },
          },
        },
        {
          $match: {
            $or: [
              { "items.productId": { $in: productIds } },
              { "items.productIdStr": { $in: productIdStrings } },
            ],
          },
        },
        {
          $group: {
            _id: "$items.productIdStr",
            soldQty: { $sum: { $ifNull: ["$items.quantity", 1] } },
          },
        },
      ]).toArray();

      const soldMap = {};
      soldAgg.forEach((s) => {
        soldMap[s._id] = s.soldQty;
      });

      // Enrich products with sold quantities
      const enrichedProducts = products.map((p) => ({
        ...p,
        soldQty: soldMap[p._id?.toString()] || 0,
        totalSold: soldMap[p._id?.toString()] || 0,
      }));

      // Debug log
      if (enrichedProducts.length > 0) {
        console.log("✅ Admin products API - first product:", {
          name: enrichedProducts[0].name,
          storeName: enrichedProducts[0].storeName,
          stock: enrichedProducts[0].stock,
          soldQty: enrichedProducts[0].soldQty,
        });
      }

      res.json({
        products: enrichedProducts,
        total,
        page: pageNum,
        limit: limitNum,
        totalPages: Math.max(Math.ceil(total / limitNum), 1),
      });
    } catch (err) {
      console.error("GET /api/admin/products error:", err);
      res.status(500).json({ message: "Failed to fetch products." });
    }
  }
);

/* ------------------------------------------------------------------
   GET /api/admin/product/:id
   ↳ Fetch single product for admin edit
------------------------------------------------------------------- */
router.get(
  "/product/:id",
  authMiddleware,
  isActiveMiddleware,
  async (req, res) => {
    try {
      if (!ensureAdminOrSuper(req, res)) return;

      const _id = ensureObjectId(req.params.id);
      if (!_id) {
        return res.status(400).json({ message: "Invalid product ID" });
      }

      const product = await Products.findOne({ _id });
      if (!product) {
        return res.status(404).json({ message: "Product not found" });
      }

      // Enrich with seller info
      const sellerIdRaw = product.sellerId || product.userId || null;
      let storeName = product.storeName || product.sellerStoreName || "";
      let sellerName = product.sellerName || product.ownerName || "";

      if (sellerIdRaw && ObjectId.isValid(sellerIdRaw)) {
        const seller = await Users.findOne({ _id: new ObjectId(sellerIdRaw) });
        if (seller) {
          storeName =
            storeName ||
            seller.storeName ||
            seller.shopName ||
            seller.name ||
            seller.email ||
            "";
          sellerName = seller.name || seller.fullName || seller.email || seller.mobile || seller.phone || sellerName;
        }
      }

      res.json({
        ...product,
        storeName,
        sellerStoreName: storeName,
        sellerName,
      });
    } catch (err) {
      console.error("GET /api/admin/product/:id error:", err);
      res.status(500).json({ message: "Failed to load product." });
    }
  }
);

/* ------------------------------------------------------------------
   PUT /api/admin/product/:id
   ↳ Update product (Admin Edit Form)
------------------------------------------------------------------- */
router.put(
  "/product/:id",
  authMiddleware,
  isActiveMiddleware,
  async (req, res) => {
    try {
      if (!ensureAdminOrSuper(req, res)) return;

      const _id = ensureObjectId(req.params.id);
      if (!_id) {
        return res.status(400).json({ message: "Invalid product ID" });
      }

      const existing = await Products.findOne({ _id });
      if (!existing) {
        return res.status(404).json({ message: "Product not found" });
      }

      // ❌ Never allow admin to change ownership
      const {
        _id: bodyId,
        userId,
        sellerId,
        createdAt,
        ...body
      } = req.body || {};

      if (!body.barcode || !body.name || !body.category) {
        return res.status(400).json({
          message: "barcode, name and category are required",
        });
      }

      // Ensure legacy compatibility
      const title = body.title || body.name;

      const allowedFields = [
        "barcode",
        "name",
        "title",
        "category",
        "brand",
        "description",
        "price",
        "quantity",
        "image",
        "images",
        "costPrice",
        "compareAtPrice",
        "hasVariants",
        "variants",
        // admin-only
        "status",
        "blocked",
        "reviewNotes",
        "rejectionReason",
      ];

      const updateDoc = {};
      for (const key of allowedFields) {
        if (body[key] !== undefined) {
          updateDoc[key] = body[key];
        }
      }

      updateDoc.title = title;
      updateDoc.updatedAt = new Date();
      updateDoc.updatedBy = req.user.id;

      await Products.updateOne(
        { _id },
        { $set: updateDoc }
      );

      const updated = await Products.findOne({ _id });

      res.json({
        message: "Product updated successfully",
        product: updated,
      });
    } catch (err) {
      console.error("PUT /api/admin/product/:id error:", err);
      res.status(500).json({ message: "Failed to update product." });
    }
  }
);

/* ------------------------------------------------------------------
   PATCH /api/admin/products/:id/approve
------------------------------------------------------------------- */
router.patch(
  "/products/:id/approve",
  authMiddleware,
  isActiveMiddleware,
  async (req, res) => {
    try {
      if (!ensureAdminOrSuper(req, res)) return;

      const _id = ensureObjectId(req.params.id);
      if (!_id) {
        return res.status(400).json({ message: "Invalid product ID" });
      }

      const result = await Products.findOneAndUpdate(
        { _id, deleted: { $ne: true } },
        {
          $set: {
            status: "approved",
            rejectionReason: null,
            reviewNotes: req.body?.reviewNotes || null,
            reviewedBy: req.user.id,
            reviewedAt: new Date(),
            updatedAt: new Date(),
          },
        },
        { returnDocument: "after" }
      );

      if (!result.value) {
        return res.status(404).json({ message: "Product not found" });
      }

      res.json({
        message: "Product approved successfully",
        product: result.value,
      });
    } catch (err) {
      console.error("Approve product error:", err);
      res.status(500).json({ message: "Failed to approve product." });
    }
  }
);

/* ------------------------------------------------------------------
   PATCH /api/admin/products/:id/reject
------------------------------------------------------------------- */
router.patch(
  "/products/:id/reject",
  authMiddleware,
  isActiveMiddleware,
  async (req, res) => {
    try {
      if (!ensureAdminOrSuper(req, res)) return;

      const _id = ensureObjectId(req.params.id);
      const { reason, reviewNotes } = req.body || {};

      if (!_id) {
        return res.status(400).json({ message: "Invalid product ID" });
      }

      if (!reason || !reason.trim()) {
        return res.status(400).json({
          message: "Rejection reason is required.",
        });
      }

      const result = await Products.findOneAndUpdate(
        { _id, deleted: { $ne: true } },
        {
          $set: {
            status: "rejected",
            rejectionReason: reason.trim(),
            reviewNotes: reviewNotes || null,
            reviewedBy: req.user.id,
            reviewedAt: new Date(),
            updatedAt: new Date(),
          },
        },
        { returnDocument: "after" }
      );

      if (!result.value) {
        return res.status(404).json({ message: "Product not found" });
      }

      res.json({
        message: "Product rejected successfully",
        product: result.value,
      });
    } catch (err) {
      console.error("Reject product error:", err);
      res.status(500).json({ message: "Failed to reject product." });
    }
  }
);

/* ------------------------------------------------------------------
   DELETE /api/admin/products/:id
------------------------------------------------------------------- */
router.delete(
  "/products/:id",
  authMiddleware,
  isActiveMiddleware,
  async (req, res) => {
    try {
      if (!ensureAdminOrSuper(req, res)) return;

      const _id = ensureObjectId(req.params.id);
      if (!_id) {
        return res.status(400).json({ message: "Invalid product ID" });
      }

      const result = await Products.findOneAndUpdate(
        { _id, deleted: { $ne: true } },
        {
          $set: {
            deleted: true,
            status: "deleted",
            updatedAt: new Date(),
          },
        },
        { returnDocument: "after" }
      );

      if (!result.value) {
        return res.status(404).json({ message: "Product not found" });
      }

      res.json({ message: "Product deleted successfully" });
    } catch (err) {
      console.error("Delete product error:", err);
      res.status(500).json({ message: "Failed to delete product." });
    }
  }
);

export default router;
