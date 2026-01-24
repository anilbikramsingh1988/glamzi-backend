// routes/brandRoutes.js
import express from "express";
import { ObjectId } from "mongodb";
import multer from "multer";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

import { client } from "../dbConfig.js";
import { authMiddleware } from "../middlewares/authMiddleware.js";

const router = express.Router();

// ================== DB SETUP ==================
const dbName = process.env.DB_NAME || "glamzi_ecommerce";
const db = client.db(dbName);

const Brands = db.collection("brands");
const BrandSuggestions = db.collection("brandSuggestions");

// ================== FILE UPLOAD (LOGOS) ==================

// ESM __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const brandLogosDir = path.join(__dirname, "..", "uploads", "brand-logos");
if (!fs.existsSync(brandLogosDir)) {
  fs.mkdirSync(brandLogosDir, { recursive: true });
}

const brandLogoStorage = multer.diskStorage({
  destination(req, file, cb) {
    cb(null, brandLogosDir);
  },
  filename(req, file, cb) {
    const ext = path.extname(file.originalname);
    const base = path.basename(file.originalname, ext);
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `brand-${base}-${unique}${ext}`);
  },
});

const uploadLogo = multer({ storage: brandLogoStorage });

// ================== HELPERS ==================

const isAdminOrSuperAdmin = (req, res, next) => {
  const role = (req.user?.role || "").toLowerCase();
  if (role === "admin" || role === "super-admin") {
    return next();
  }
  return res.status(403).json({ message: "Admin access only" });
};

// ================== PUBLIC BRANDS ==================

/**
 * GET /api/brands
 * ✅ Public: only APPROVED + ACTIVE brands
 */
router.get("/brands", async (req, res) => {
  try {
    const brands = await Brands.find({
      status: "approved",
      isActive: true,
    })
      .sort({ name: 1 })
      .toArray();

    res.json({ brands });
  } catch (err) {
    console.error("Error fetching public brands:", err);
    res.status(500).json({
      message: "Error fetching brands",
      error: err.message,
    });
  }
});

/**
 * GET /api/brands/:id
 * ✅ Public: brand details by ID (approved + active)
 */
router.get("/brands/:id", async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid brand ID" });
    }

    const brand = await Brands.findOne({
      _id: new ObjectId(id),
      status: "approved",
      isActive: true,
    });

    if (!brand) {
      return res.status(404).json({ message: "Brand not found" });
    }

    res.json({ brand });
  } catch (err) {
    console.error("Error fetching brand by id:", err);
    res.status(500).json({
      message: "Error fetching brand",
      error: err.message,
    });
  }
});

/**
 * GET /api/brands/slug/:slug
 * ✅ Public: brand details by slug (approved + active)
 */
router.get("/brands/slug/:slug", async (req, res) => {
  try {
    const { slug } = req.params;
    const normalized = (slug || "").trim().toLowerCase();
    if (!normalized) {
      return res.status(400).json({ message: "Invalid brand slug" });
    }

    const brand = await Brands.findOne({
      slug: normalized,
      status: "approved",
      isActive: true,
    });

    if (!brand) {
      return res.status(404).json({ message: "Brand not found" });
    }

    res.json({ brand });
  } catch (err) {
    console.error("Error fetching brand by slug:", err);
    res.status(500).json({
      message: "Error fetching brand",
      error: err.message,
    });
  }
});

// ================== SELLER: SUGGEST BRAND ==================

/**
 * POST /api/seller/brands/suggest
 * ✅ Seller only
 * Body JSON:
 *  - name*        (string)
 *  - description? (string)
 *  - logoUrl?     (string, optional URL to brand logo)
 */
router.post("/seller/brands/suggest", authMiddleware, async (req, res) => {
  try {
    const role = (req.user?.role || "").toLowerCase();
    if (role !== "seller") {
      return res
        .status(403)
        .json({ message: "Only sellers can suggest brands" });
    }

    const { name, description, logoUrl } = req.body;

    const trimmedName = (name || "").trim();
    if (!trimmedName) {
      return res.status(400).json({ message: "Brand name is required" });
    }

    const now = new Date();

    const suggestion = {
      name: trimmedName,
      description: (description || "").trim(),
      logoUrl: logoUrl || "",

      sellerId: new ObjectId(req.user.id),

      status: "pending", // pending | approved | rejected
      linkedBrandId: null,

      createdAt: now,
      updatedAt: now,
      resolvedAt: null,
      resolvedBy: null,
    };

    await BrandSuggestions.insertOne(suggestion);

    res.json({
      message: "Brand suggestion submitted successfully",
    });
  } catch (err) {
    console.error("Seller brand suggestion error:", err);
    res.status(500).json({
      message: "Error submitting brand suggestion",
      error: err.message,
    });
  }
});

// ================== ADMIN: LIST + CREATE + EDIT ==================

/**
 * GET /api/admin/brands
 * ✅ Admin + Super Admin
 * Query: ?status=all|pending|approved|rejected|inactive
 */
router.get(
  "/admin/brands",
  authMiddleware,
  isAdminOrSuperAdmin,
  async (req, res) => {
    try {
      const { status = "all" } = req.query;
      const filter = {};

      const s = (status || "").toLowerCase();
      if (s === "pending") filter.status = "pending";
      else if (s === "approved") filter.status = "approved";
      else if (s === "rejected") filter.status = "rejected";
      else if (s === "inactive") {
        filter.isActive = false;
      }

      const brands = await Brands.find(filter)
        .sort({ createdAt: -1 })
        .toArray();

      res.json({ brands });
    } catch (err) {
      console.error("Error loading admin brands:", err);
      res.status(500).json({
        message: "Error loading brands",
        error: err.message,
      });
    }
  }
);

/**
 * POST /api/admin/brands
 * ✅ Admin + Super Admin
 * Payload: multipart/form-data
 *  - name* (string)
 *  - slug? (string)
 *  - description? (string)
 *  - logo (file)
 * New brand is created as PENDING + INACTIVE, must be approved by super-admin
 */
router.post(
  "/admin/brands",
  authMiddleware,
  isAdminOrSuperAdmin,
  uploadLogo.single("logo"),
  async (req, res) => {
    try {
      const { name, slug, description } = req.body;

      const trimmedName = (name || "").trim();
      if (!trimmedName) {
        return res.status(400).json({ message: "Brand name is required" });
      }

      const finalSlug =
        (slug ||
          trimmedName
            .toLowerCase()
            .replace(/\s+/g, "-")
            .replace(/[^a-z0-9-]/g, "")) || "";

      const existing = await Brands.findOne({
        $or: [{ name: trimmedName }, { slug: finalSlug }],
      });

      if (existing) {
        return res.status(400).json({
          message: "Brand with same name or slug already exists",
        });
      }

      let logoUrl = "";
      if (req.file) {
        logoUrl = `${req.protocol}://${req.get(
          "host"
        )}/uploads/brand-logos/${req.file.filename}`;
      }

      const now = new Date();

      const doc = {
        name: trimmedName,
        slug: finalSlug,
        description: (description || "").trim(),
        logoUrl,

        status: "pending", // must be approved
        isActive: false,

        createdBy: new ObjectId(req.user.id),
        approvedBy: null,
        approvedAt: null,

        createdAt: now,
        updatedAt: now,
      };

      const result = await Brands.insertOne(doc);

      res.json({
        message: "Brand created (pending approval)",
        brandId: result.insertedId,
      });
    } catch (err) {
      console.error("Create brand error:", err);
      res.status(500).json({
        message: "Error creating brand",
        error: err.message,
      });
    }
  }
);

/**
 * PUT /api/admin/brands/:id
 * ✅ Admin + Super Admin
 * Edit brand name / slug / description / logo (no status change here)
 */
router.put(
  "/admin/brands/:id",
  authMiddleware,
  isAdminOrSuperAdmin,
  uploadLogo.single("logo"),
  async (req, res) => {
    try {
      const { id } = req.params;

      if (!ObjectId.isValid(id)) {
        return res.status(400).json({ message: "Invalid brand ID" });
      }

      const { name, slug, description } = req.body;
      const update = {};
      const now = new Date();

      if (name !== undefined) {
        const trimmedName = (name || "").trim();
        if (!trimmedName) {
          return res
            .status(400)
            .json({ message: "Brand name cannot be empty" });
        }
        update.name = trimmedName;
      }

      if (slug !== undefined) {
        const finalSlug = (slug || "")
          .toLowerCase()
          .replace(/\s+/g, "-")
          .replace(/[^a-z0-9-]/g, "")
          .trim();
        if (!finalSlug) {
          return res
            .status(400)
            .json({ message: "Brand slug cannot be empty" });
        }
        update.slug = finalSlug;
      }

      if (description !== undefined) {
        update.description = (description || "").trim();
      }

      if (req.file) {
        update.logoUrl = `${req.protocol}://${req.get(
          "host"
        )}/uploads/brand-logos/${req.file.filename}`;
      }

      if (!Object.keys(update).length) {
        return res.status(400).json({ message: "Nothing to update" });
      }

      update.updatedAt = now;

      const result = await Brands.updateOne(
        { _id: new ObjectId(id) },
        { $set: update }
      );

      if (!result.matchedCount) {
        return res.status(404).json({ message: "Brand not found" });
      }

      res.json({ message: "Brand updated successfully" });
    } catch (err) {
      console.error("Update brand error:", err);
      res.status(500).json({
        message: "Error updating brand",
        error: err.message,
      });
    }
  }
);

// ================== SUPER ADMIN: APPROVE / ACTIVATE / DEACTIVATE ==================

/**
 * PUT /api/admin/brands/:id/approve
 * ✅ Super Admin only
 */
router.put("/admin/brands/:id/approve", authMiddleware, async (req, res) => {
  try {
    const role = (req.user.role || "").toLowerCase();
    if (role !== "super-admin") {
      return res
        .status(403)
        .json({ message: "Only super-admin can approve brands" });
    }

    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid brand ID" });
    }

    const now = new Date();

    const result = await Brands.updateOne(
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
      return res.status(404).json({ message: "Brand not found" });
    }

    res.json({ message: "Brand approved successfully" });
  } catch (err) {
    console.error("Approve brand error:", err);
    res.status(500).json({
      message: "Error approving brand",
      error: err.message,
    });
  }
});

/**
 * PUT /api/admin/brands/:id/deactivate
 * ✅ Super Admin only
 */
router.put(
  "/admin/brands/:id/deactivate",
  authMiddleware,
  async (req, res) => {
    try {
      const role = (req.user.role || "").toLowerCase();
      if (role !== "super-admin") {
        return res
          .status(403)
          .json({ message: "Only super-admin can deactivate brands" });
      }

      const { id } = req.params;
      if (!ObjectId.isValid(id)) {
        return res.status(400).json({ message: "Invalid brand ID" });
      }

      const result = await Brands.updateOne(
        { _id: new ObjectId(id) },
        {
          $set: {
            isActive: false,
            updatedAt: new Date(),
          },
        }
      );

      if (!result.matchedCount) {
        return res.status(404).json({ message: "Brand not found" });
      }

      res.json({ message: "Brand deactivated successfully" });
    } catch (err) {
      console.error("Deactivate brand error:", err);
      res.status(500).json({
        message: "Error deactivating brand",
        error: err.message,
      });
    }
  }
);

/**
 * PUT /api/admin/brands/:id/activate
 * ✅ Super Admin only
 */
router.put("/admin/brands/:id/activate", authMiddleware, async (req, res) => {
  try {
    const role = (req.user.role || "").toLowerCase();
    if (role !== "super-admin") {
      return res
        .status(403)
        .json({ message: "Only super-admin can activate brands" });
    }

    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid brand ID" });
    }

    const result = await Brands.updateOne(
      { _id: new ObjectId(id) },
      {
        $set: {
          isActive: true,
          updatedAt: new Date(),
        },
      }
    );

    if (!result.matchedCount) {
      return res.status(404).json({ message: "Brand not found" });
    }

    res.json({ message: "Brand activated successfully" });
  } catch (err) {
    console.error("Activate brand error:", err);
    res.status(500).json({
      message: "Error activating brand",
      error: err.message,
    });
  }
});

// ================== ADMIN: VIEW BRAND SUGGESTIONS ==================

/**
 * GET /api/admin/brand-suggestions
 * ✅ Admin + Super Admin
 * Query: ?status=all|pending|approved|rejected
 */
router.get(
  "/admin/brand-suggestions",
  authMiddleware,
  isAdminOrSuperAdmin,
  async (req, res) => {
    try {
      const { status = "all" } = req.query;
      const filter = {};

      const s = (status || "").toLowerCase();
      if (s === "pending") filter.status = "pending";
      else if (s === "approved") filter.status = "approved";
      else if (s === "rejected") filter.status = "rejected";

      const suggestions = await BrandSuggestions.find(filter)
        .sort({ createdAt: -1 })
        .toArray();

      res.json({ suggestions });
    } catch (err) {
      console.error("Error loading brand suggestions:", err);
      res.status(500).json({
        message: "Error loading brand suggestions",
        error: err.message,
      });
    }
  }
);

// ================== SUPER ADMIN: APPROVE / REJECT SUGGESTION ==================

/**
 * PUT /api/admin/brand-suggestions/:id/approve
 * ✅ Super Admin only
 * - creates (or reuses) a brand
 * - marks suggestion as approved
 */
router.put(
  "/admin/brand-suggestions/:id/approve",
  authMiddleware,
  async (req, res) => {
    try {
      const role = (req.user.role || "").toLowerCase();
      if (role !== "super-admin") {
        return res.status(403).json({
          message: "Only super-admin can approve brand suggestions",
        });
      }

      const { id } = req.params;
      if (!ObjectId.isValid(id)) {
        return res.status(400).json({ message: "Invalid suggestion ID" });
      }

      const suggestion = await BrandSuggestions.findOne({
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

      // Check if brand already exists
      let brand = await Brands.findOne({
        $or: [{ name }, { slug }],
      });

      let brandId;

      if (brand) {
        brandId = brand._id;
      } else {
        const doc = {
          name,
          slug,
          description: suggestion.description || "",
          logoUrl: suggestion.logoUrl || "",

          status: "approved",
          isActive: true,

          createdBy: new ObjectId(req.user.id),
          approvedBy: new ObjectId(req.user.id),
          approvedAt: now,

          suggestedBy: suggestion.sellerId || null,

          createdAt: now,
          updatedAt: now,
        };

        const result = await Brands.insertOne(doc);
        brandId = result.insertedId;
      }

      await BrandSuggestions.updateOne(
        { _id: suggestion._id },
        {
          $set: {
            status: "approved",
            linkedBrandId: brandId,
            resolvedBy: new ObjectId(req.user.id),
            resolvedAt: now,
            updatedAt: now,
          },
        }
      );

      res.json({
        message: "Brand suggestion approved and brand available",
        brandId,
      });
    } catch (err) {
      console.error("Approve brand suggestion error:", err);
      res.status(500).json({
        message: "Error approving brand suggestion",
        error: err.message,
      });
    }
  }
);

/**
 * PUT /api/admin/brand-suggestions/:id/reject
 * ✅ Super Admin only
 */
router.put(
  "/admin/brand-suggestions/:id/reject",
  authMiddleware,
  async (req, res) => {
    try {
      const role = (req.user.role || "").toLowerCase();
      if (role !== "super-admin") {
        return res.status(403).json({
          message: "Only super-admin can reject brand suggestions",
        });
      }

      const { id } = req.params;
      if (!ObjectId.isValid(id)) {
        return res.status(400).json({ message: "Invalid suggestion ID" });
      }

      const now = new Date();

      const result = await BrandSuggestions.updateOne(
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

      res.json({ message: "Brand suggestion rejected" });
    } catch (err) {
      console.error("Reject brand suggestion error:", err);
      res.status(500).json({
        message: "Error rejecting brand suggestion",
        error: err.message,
      });
    }
  }
);

export default router;
