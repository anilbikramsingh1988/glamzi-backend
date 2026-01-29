import express from "express";
import { ObjectId } from "mongodb";
import { client } from "../dbConfig.js";
import { authMiddleware } from "../middlewares/authMiddleware.js";

const router = express.Router();

// ✅ DB SETUP
const dbName = process.env.DB_NAME || "glamzi_ecommerce";
const db = client.db(dbName);
const Categories = db.collection("categories");
const CategorySuggestions = db.collection("categorySuggestions");
const Users = db.collection("users");
const AdminNotifications = db.collection("admin_notifications");

const toObjectIdSafe = (value) => {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw || !ObjectId.isValid(raw)) return null;
  return new ObjectId(raw);
};

/* =========================================================
   PUBLIC
   ========================================================= */

/**
 * ✅ PUBLIC
 * GET /api/categories
 * Only show APPROVED + ACTIVE categories
 */
router.get("/categories", async (req, res) => {
  try {
    const includeAll = ["1", "true", "yes"].includes(
      String(req.query.includeAll || req.query.includeChildren || "").toLowerCase()
    );
    const parentIdRaw = String(req.query.parentId || "").trim();
    const levelRaw = String(req.query.level || "").trim();

    const filter = {
      status: "approved",
      isActive: true,
    };

    if (!includeAll) {
      if (parentIdRaw) {
        if (["null", "root", "top"].includes(parentIdRaw.toLowerCase())) {
          filter.$or = [{ parentId: { $exists: false } }, { parentId: null }];
        } else {
          const parentId = toObjectIdSafe(parentIdRaw);
          filter.parentId = parentId || parentIdRaw;
        }
      } else {
        filter.$or = [{ parentId: { $exists: false } }, { parentId: null }];
      }
    }

    if (levelRaw) {
      const level = Number(levelRaw);
      if (Number.isFinite(level)) {
        filter.level = level;
      }
    }

    const categories = await Categories.find(filter)
      .sort({ name: 1 })
      .toArray();

    res.json({ categories });
  } catch (err) {
    console.error("Error fetching public categories:", err);
    res.status(500).json({
      message: "Error fetching categories",
      error: err.message,
    });
  }
});

/* =========================================================
   ADMIN: CATEGORY LIST + CREATE
   ========================================================= */

/**
 * ✅ ADMIN + SUPER ADMIN
 * GET /api/admin/categories
 * View all categories (all statuses)
 */
router.get("/admin/categories", authMiddleware, async (req, res) => {
  try {
    const role = (req.user.role || "").toLowerCase();
    if (!["admin", "super-admin"].includes(role)) {
      return res.status(403).json({ message: "Admin access only" });
    }

    const categories = await Categories.find({})
      .sort({ createdAt: -1 })
      .toArray();

    res.json({ categories });
  } catch (err) {
    console.error("Error loading admin categories:", err);
    res.status(500).json({
      message: "Error loading categories",
      error: err.message,
    });
  }
});

/**
 * ✅ ADMIN + SUPER ADMIN
 * POST /api/admin/categories
 * Create category → PENDING
 */
router.post("/admin/categories", authMiddleware, async (req, res) => {
  try {
    const role = (req.user.role || "").toLowerCase();
    if (!["admin", "super-admin"].includes(role)) {
      return res.status(403).json({ message: "Admin access only" });
    }

    const { name, slug, description, seoTitle, seoDescription, parentId: parentIdRaw } =
      req.body;

    const trimmedName = (name || "").trim();
    if (!trimmedName) {
      return res.status(400).json({ message: "Category name is required" });
    }

    const finalSlug =
      (slug || trimmedName.toLowerCase().replace(/\s+/g, "-"))
        .replace(/[^a-z0-9-]/g, "")
        .trim();

    const existing = await Categories.findOne({
      $or: [{ name: trimmedName }, { slug: finalSlug }],
    });

    if (existing) {
      return res.status(400).json({
        message: "Category with same name or slug already exists",
      });
    }

    const now = new Date();
    let parentId = null;
    let level = 1;

    if (parentIdRaw) {
      parentId = toObjectIdSafe(parentIdRaw);
      if (!parentId) {
        return res.status(400).json({ message: "Invalid parent category ID" });
      }

      const parent = await Categories.findOne({ _id: parentId });
      if (!parent) {
        return res.status(400).json({ message: "Parent category not found" });
      }

      const parentLevel = Number(parent.level || 1);
      level = Number.isFinite(parentLevel) ? parentLevel + 1 : 2;
    }

    const doc = {
      name: trimmedName,
      slug: finalSlug,
      description: (description || "").trim(),
      seoTitle: (seoTitle || "").trim(),
      seoDescription: (seoDescription || "").trim(),
      parentId: parentId || null,
      level,

      status: "pending", // ✅ needs super admin approval
      isActive: false, // ✅ inactive until approved

      createdBy: new ObjectId(req.user.id),
      approvedBy: null,
      approvedAt: null,

      createdAt: now,
      updatedAt: now,
    };

    const result = await Categories.insertOne(doc);

    try {
      await AdminNotifications.insertOne({
        type: "category_pending",
        title: "New category pending",
        body: `${trimmedName} is awaiting approval.`,
        categoryId: result.insertedId,
        read: false,
        createdAt: now,
      });
    } catch (notifyErr) {
      console.error("Admin notification insert failed:", notifyErr);
    }

    res.json({
      message: "Category created (pending approval)",
      categoryId: result.insertedId,
    });
  } catch (err) {
    console.error("Create category error:", err);
    res.status(500).json({
      message: "Error creating category",
      error: err.message,
    });
  }
});

/**
 * ✅ ADMIN + SUPER ADMIN
 * PUT /api/admin/categories/:id
 * Edit category name / slug
 */
router.put("/admin/categories/:id", authMiddleware, async (req, res) => {
  try {
    const role = (req.user.role || "").toLowerCase();
    if (!["admin", "super-admin"].includes(role)) {
      return res.status(403).json({ message: "Admin access only" });
    }

    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid category ID" });
    }

    const { name, slug, description, seoTitle, seoDescription, parentId: parentIdRaw } =
      req.body;
    const trimmedName = (name || "").trim();
    if (!trimmedName) {
      return res.status(400).json({ message: "Category name is required" });
    }

    const finalSlug =
      (slug || trimmedName.toLowerCase().replace(/\s+/g, "-"))
        .replace(/[^a-z0-9-]/g, "")
        .trim();

    // Ensure uniqueness (excluding this category)
    const existing = await Categories.findOne({
      _id: { $ne: new ObjectId(id) },
      $or: [{ name: trimmedName }, { slug: finalSlug }],
    });

    if (existing) {
      return res.status(400).json({
        message: "Another category with same name or slug already exists",
      });
    }

    const now = new Date();
    const updateDoc = {
      name: trimmedName,
      slug: finalSlug,
      description: (description || "").trim(),
      seoTitle: (seoTitle || "").trim(),
      seoDescription: (seoDescription || "").trim(),
      updatedAt: now,
    };

    const hasParentId = Object.prototype.hasOwnProperty.call(req.body, "parentId");
    if (hasParentId) {
      if (!parentIdRaw) {
        updateDoc.parentId = null;
        updateDoc.level = 1;
      } else {
        const parentId = toObjectIdSafe(parentIdRaw);
        if (!parentId) {
          return res.status(400).json({ message: "Invalid parent category ID" });
        }
        if (String(parentId) === String(id)) {
          return res.status(400).json({ message: "Category cannot be its own parent" });
        }

        const parent = await Categories.findOne({ _id: parentId });
        if (!parent) {
          return res.status(400).json({ message: "Parent category not found" });
        }

        const parentLevel = Number(parent.level || 1);
        updateDoc.parentId = parentId;
        updateDoc.level = Number.isFinite(parentLevel) ? parentLevel + 1 : 2;
      }
    }

    const result = await Categories.updateOne(
      { _id: new ObjectId(id) },
      { $set: updateDoc }
    );

    if (!result.matchedCount) {
      return res.status(404).json({ message: "Category not found" });
    }

    res.json({ message: "Category updated successfully" });
  } catch (err) {
    console.error("Update category error:", err);
    res.status(500).json({
      message: "Error updating category",
      error: err.message,
    });
  }
});

/* =========================================================
   SUPER ADMIN: APPROVE / DEACTIVATE / ACTIVATE
   ========================================================= */

/**
 * ✅ SUPER ADMIN ONLY
 * PUT /api/admin/categories/:id/approve
 */
router.put(
  "/admin/categories/:id/approve",
  authMiddleware,
  async (req, res) => {
    try {
      const role = (req.user.role || "").toLowerCase();
      if (role !== "super-admin") {
        return res
          .status(403)
          .json({ message: "Only super-admin can approve categories" });
      }

      const { id } = req.params;
      if (!ObjectId.isValid(id)) {
        return res.status(400).json({ message: "Invalid category ID" });
      }

      const now = new Date();

      const result = await Categories.updateOne(
        { _id: new ObjectId(id) },
        {
          $set: {
            status: "approved",
            isActive: true,
            approvedBy: new ObjectId(req.user.id),
            approvedAt: now,
            updatedAt: now,
          },
        }
      );

      if (!result.matchedCount) {
        return res.status(404).json({ message: "Category not found" });
      }

      res.json({ message: "Category approved successfully" });
    } catch (err) {
      console.error("Approve category error:", err);
      res.status(500).json({
        message: "Error approving category",
        error: err.message,
      });
    }
  }
);

/**
 * ✅ SUPER ADMIN ONLY
 * PUT /api/admin/categories/:id/deactivate
 */
router.put(
  "/admin/categories/:id/deactivate",
  authMiddleware,
  async (req, res) => {
    try {
      const role = (req.user.role || "").toLowerCase();
      if (role !== "super-admin") {
        return res
          .status(403)
          .json({ message: "Only super-admin can deactivate categories" });
      }

      const { id } = req.params;
      if (!ObjectId.isValid(id)) {
        return res.status(400).json({ message: "Invalid category ID" });
      }

      const result = await Categories.updateOne(
        { _id: new ObjectId(id) },
        {
          $set: {
            isActive: false,
            updatedAt: new Date(),
          },
        }
      );

      if (!result.matchedCount) {
        return res.status(404).json({ message: "Category not found" });
      }

      res.json({ message: "Category deactivated successfully" });
    } catch (err) {
      console.error("Deactivate category error:", err);
      res.status(500).json({
        message: "Error deactivating category",
        error: err.message,
      });
    }
  }
);

/**
 * ✅ SUPER ADMIN ONLY
 * PUT /api/admin/categories/:id/activate
 */
router.put(
  "/admin/categories/:id/activate",
  authMiddleware,
  async (req, res) => {
    try {
      const role = (req.user.role || "").toLowerCase();
      if (role !== "super-admin") {
        return res
          .status(403)
          .json({ message: "Only super-admin can activate categories" });
      }

      const { id } = req.params;
      if (!ObjectId.isValid(id)) {
        return res.status(400).json({ message: "Invalid category ID" });
      }

      const result = await Categories.updateOne(
        { _id: new ObjectId(id) },
        {
          $set: {
            isActive: true,
            updatedAt: new Date(),
          },
        }
      );

      if (!result.matchedCount) {
        return res.status(404).json({ message: "Category not found" });
      }

      res.json({ message: "Category activated successfully" });
    } catch (err) {
      console.error("Activate category error:", err);
      res.status(500).json({
        message: "Error activating category",
        error: err.message,
      });
    }
  }
);

/* =========================================================
   SELLER: SUGGEST NEW CATEGORY
   ========================================================= */

/**
 * ✅ SELLER ONLY
 * POST /api/seller/categories/suggest
 * Body: { name, description?, parentId? }
 */
router.post(
  "/seller/categories/suggest",
  authMiddleware,
  async (req, res) => {
    try {
      const role = (req.user.role || "").toLowerCase();
      if (role !== "seller") {
        return res
          .status(403)
          .json({ message: "Only sellers can suggest categories" });
      }

      const { name, description, parentId: parentIdRaw } = req.body;
      const trimmedName = (name || "").trim();

      if (!trimmedName) {
        return res.status(400).json({ message: "Category name is required" });
      }

      let parentId = null;
      if (parentIdRaw) {
        parentId = toObjectIdSafe(parentIdRaw);
        if (!parentId) {
          return res.status(400).json({ message: "Invalid parent category ID" });
        }

        const parent = await Categories.findOne({ _id: parentId });
        if (!parent) {
          return res.status(400).json({ message: "Parent category not found" });
        }
      }

      // Load seller info for display in admin panel
      const seller = await Users.findOne(
        { _id: new ObjectId(req.user.id) },
        {
          projection: {
            storeName: 1,
            shopName: 1,
            ownerFirstName: 1,
            ownerLastName: 1,
            email: 1,
          },
        }
      );

      if (!seller) {
        return res.status(404).json({ message: "Seller not found" });
      }

      const sellerStoreName =
        seller.storeName || seller.shopName || "Unnamed Store";
      const sellerOwnerName = `${seller.ownerFirstName || ""} ${
        seller.ownerLastName || ""
      }`.trim();

      const now = new Date();

      const suggestion = {
        name: trimmedName,
        description: (description || "").trim(),

        sellerId: new ObjectId(req.user.id),
        sellerStoreName,
        sellerOwnerName,
        sellerEmail: seller.email,

        parentId: parentId || null,
        status: "pending", // pending | approved | rejected
        linkedCategoryId: null,

        createdAt: now,
        updatedAt: now,
        resolvedAt: null,
        resolvedBy: null,
      };

      const result = await CategorySuggestions.insertOne(suggestion);

      res.json({
        message:
          "Category suggestion submitted. Admin will review your request.",
        suggestionId: result.insertedId,
      });
    } catch (err) {
      console.error("Seller category suggestion error:", err);
      res.status(500).json({
        message: "Error submitting category suggestion",
        error: err.message,
      });
    }
  }
);

/* =========================================================
   ADMIN: VIEW SUGGESTIONS
   ========================================================= */

/**
 * ✅ ADMIN + SUPER ADMIN
 * GET /api/admin/category-suggestions
 * Optional query: ?status=pending|approved|rejected|all
 */
router.get(
  "/admin/category-suggestions",
  authMiddleware,
  async (req, res) => {
    try {
      const role = (req.user.role || "").toLowerCase();
      if (!["admin", "super-admin"].includes(role)) {
        return res.status(403).json({ message: "Admin access only" });
      }

      const { status = "all" } = req.query;
      const filter = {};

      const s = (status || "").toLowerCase();
      if (s === "pending") filter.status = "pending";
      else if (s === "approved") filter.status = "approved";
      else if (s === "rejected") filter.status = "rejected";

      const suggestions = await CategorySuggestions.find(filter)
        .sort({ createdAt: -1 })
        .toArray();

      res.json({ suggestions });
    } catch (err) {
      console.error("Error loading category suggestions:", err);
      res.status(500).json({
        message: "Error loading category suggestions",
        error: err.message,
      });
    }
  }
);

/* =========================================================
   SUPER ADMIN: APPROVE / REJECT SUGGESTION
   ========================================================= */

/**
 * ✅ SUPER ADMIN ONLY
 * PUT /api/admin/category-suggestions/:id/approve
 * - creates (or reuses) a category
 * - marks suggestion as approved
 */
router.put(
  "/admin/category-suggestions/:id/approve",
  authMiddleware,
  async (req, res) => {
    try {
      const role = (req.user.role || "").toLowerCase();
      if (role !== "super-admin") {
        return res
          .status(403)
          .json({ message: "Only super-admin can approve suggestions" });
      }

      const { id } = req.params;
      if (!ObjectId.isValid(id)) {
        return res.status(400).json({ message: "Invalid suggestion ID" });
      }

      const suggestion = await CategorySuggestions.findOne({
        _id: new ObjectId(id),
      });

      if (!suggestion) {
        return res.status(404).json({ message: "Suggestion not found" });
      }

      if (suggestion.status === "approved") {
        return res
          .status(400)
          .json({ message: "Suggestion is already approved" });
      }

      const name = (suggestion.name || "").trim();
      if (!name) {
        return res.status(400).json({ message: "Invalid suggestion name" });
      }

      const slug = name
        .toLowerCase()
        .replace(/\s+/g, "-")
        .replace(/[^a-z0-9-]/g, "")
        .trim();

      const now = new Date();

      // Check if category already exists
      let category = await Categories.findOne({
        $or: [{ name }, { slug }],
      });

      let categoryId;

      if (category) {
        categoryId = category._id;
      } else {
        // Create new category as APPROVED + ACTIVE
        const doc = {
          name,
          slug,
          description: (suggestion.description || "").trim(),
          parentId: parentId || null,
          level,
          status: "approved",
          isActive: true,

          createdBy: new ObjectId(req.user.id),
          approvedBy: new ObjectId(req.user.id),
          approvedAt: now,

          // optional: link suggestion info
          suggestedBy: suggestion.sellerId || null,

          createdAt: now,
          updatedAt: now,
        };

        const result = await Categories.insertOne(doc);
        categoryId = result.insertedId;
      }

      // Mark suggestion as approved
      await CategorySuggestions.updateOne(
        { _id: suggestion._id },
        {
          $set: {
            status: "approved",
            linkedCategoryId: categoryId,
            resolvedBy: new ObjectId(req.user.id),
            resolvedAt: now,
            updatedAt: now,
          },
        }
      );

      res.json({
        message: "Suggestion approved and category available",
        categoryId,
      });
    } catch (err) {
      console.error("Approve suggestion error:", err);
      res.status(500).json({
        message: "Error approving suggestion",
        error: err.message,
      });
    }
  }
);

/**
 * ✅ SUPER ADMIN ONLY
 * PUT /api/admin/category-suggestions/:id/reject
 */
router.put(
  "/admin/category-suggestions/:id/reject",
  authMiddleware,
  async (req, res) => {
    try {
      const role = (req.user.role || "").toLowerCase();
      if (role !== "super-admin") {
        return res
          .status(403)
          .json({ message: "Only super-admin can reject suggestions" });
      }

      const { id } = req.params;
      if (!ObjectId.isValid(id)) {
        return res.status(400).json({ message: "Invalid suggestion ID" });
      }

      const now = new Date();

      const result = await CategorySuggestions.updateOne(
        { _id: new ObjectId(id) },
        {
          $set: {
            status: "rejected",
            resolvedBy: new ObjectId(req.user.id),
            resolvedAt: now,
            updatedAt: now,
          },
        }
      );

      if (!result.matchedCount) {
        return res.status(404).json({ message: "Suggestion not found" });
      }

      res.json({ message: "Suggestion rejected" });
    } catch (err) {
      console.error("Reject suggestion error:", err);
      res.status(500).json({
        message: "Error rejecting suggestion",
        error: err.message,
      });
    }
  }
);

export default router;
