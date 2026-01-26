// routes/productRoute.js
// public product listing + detail + recommendations + admin product list/block + product views

import express from "express";
import { ObjectId } from "mongodb";

import { authMiddleware } from "../middlewares/authMiddleware.js";
import { client } from "../dbConfig.js";

const router = express.Router();
const db = client.db("glamzi_ecommerce");

const Products = db.collection("products");
const Users = db.collection("users");
const Orders = db.collection("orders"); // âœ… orders collection for sold qty
const ProductViews = db.collection("productViews"); // âœ… merged in from productViewRoutes
const Reviews = db.collection("reviews"); // âœ… reviews collection
const Brands = db.collection("brands"); // âœ… brands collection
const ProductsConfig = db.collection("productsConfig");
const PRODUCTS_CONFIG_ID = "products-config";


/** バ. Load global products configuration (with defaults) */
async function getProductConfig() {
  const config = await ProductsConfig.findOne({ _id: PRODUCTS_CONFIG_ID });
  if (!config) {
    return {
      limits: { maxImages: 8, maxVariants: 20, maxTitleLen: 120, maxDescLen: 5000 },
      pricing: {
        minPrice: 1,
        maxPrice: 10000000,
        defaultCurrency: "NPR",
        allowNegotiation: true,
        requireCompareAtToBeHigher: true,
      },
      inventory: { trackStock: true, lowStockThreshold: 5, allowBackorder: false },
      shipping: { requireWeight: false, requireDimensions: false, weightUnit: "kg" },
      visibility: { allowDraft: true, allowSchedule: true, allowHideOutOfStock: false },
      moderation: { requireApproval: true, autoRejectBannedWords: true },
      seo: { autoSlug: true, enforceUniqueSlug: true, appendBrandToTitle: false },
      content: { bannedWords: [], blockedDomains: [] },
    };
  }
  return config;
}


/** âœ… Helper: safely cast to ObjectId (return null if invalid) */
function toObjectId(id) {
  try {
    if (!id || !ObjectId.isValid(id)) return null;
    return new ObjectId(id);
  } catch {
    return null;
  }
}

/** âœ… Admin/staff roles allowed for admin product endpoints */
function isAdminStaff(user) {
  const role = (user?.role || "").toLowerCase();
  const allowed = ["admin", "super-admin", "account", "marketing", "support"];
  return allowed.includes(role);
}

/** âœ… Escape regex input */
function escapeRegex(str = "") {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** ãƒ. Slugify helper (lowercase, dash-separated, safe ASCII) */
function slugifyValue(str = "") {
  return String(str || "")
    .trim()
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** ãƒ. Generate a unique slug for a product */
async function generateUniqueProductSlug({ title, brand, variant, providedSlug }) {
  const rawSource =
    providedSlug ||
    [brand, title, variant]
      .filter(Boolean)
      .map((v) => String(v))
      .join(" ");

  let base = slugifyValue(rawSource);
  if (!base) {
    base = `product-${new ObjectId().toString().slice(-6)}`;
  }

  let slug = base;
  let attempt = 1;

  // Retry with suffixes if slug already exists
  while (
    await Products.findOne(
      { slug, deleted: { $ne: true } },
      { projection: { _id: 1 } }
    )
  ) {
    if (attempt > 5) {
      slug = `${base}-${new ObjectId().toString().slice(-6)}`;
      break;
    }
    slug = `${base}-${attempt}`;
    attempt += 1;
  }

  return slug;
}

/** ãƒ. Ensure an existing product has a slug (generate + persist if missing) */
async function ensureProductHasSlug(product) {
  if (!product || !product._id) return null;
  if (product.slug) return product.slug;

  const slug = await generateUniqueProductSlug({
    title: product.title || product.name,
    brand: product.brand,
    variant: product.variant,
  });

  await Products.updateOne(
    { _id: product._id },
    { $set: { slug, updatedAt: new Date() } }
  );

  product.slug = slug;
  return slug;
}

/** ãƒ. Enrich product with review stats */
async function attachProductStats(product) {
  if (!product) return null;

  const id = product._id;

  const stats = await Reviews.aggregate([
    { $match: { productId: id, status: "approved" } },
    {
      $group: {
        _id: null,
        totalReviews: { $sum: 1 },
        sumRating: { $sum: "$rating" },
      },
    },
  ]).toArray();

  let averageRating = 0;
  let totalReviews = 0;

  if (stats.length > 0) {
    totalReviews = stats[0].totalReviews || 0;
    const sumRating = stats[0].sumRating || 0;
    averageRating = totalReviews > 0 ? sumRating / totalReviews : 0;
  }

  return { ...product, averageRating, totalReviews };
}

/* =========================================================
   PRODUCT VIEW TRACKING (MERGED)
========================================================= */

/**
 * POST /api/track/product-view
 * Body: { productId, sellerId, title, imageUrl, price }
 * Requires: logged-in user (customer)
 */
router.post("/track/product-view", authMiddleware, async (req, res) => {
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
        $setOnInsert: { createdAt: now },
      },
      { upsert: true }
    );

    return res.json({ success: true });
  } catch (err) {
    console.error("Error in POST /track/product-view:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

/* =========================================================
   CREATE PRODUCT
========================================================= */

/**
 * Core handler: create product
 * - Seller-created products => status: "pending"
 * - Admin/staff-created products => status: "approved" by default
 */
async function handleCreateProduct(req, res) {
  try {
    const config = await getProductConfig();
    const { limits = {}, pricing = {}, shipping = {}, moderation = {}, content = {}, seo = {} } =
      config || {};

    const { title, description, price, category, location, condition, images } =
      req.body;

    if (!title || !description || price == null) {
      return res
        .status(400)
        .json({ message: "Title, description and price are required" });
    }

    const ownerObjectId = toObjectId(req.user.id);
    if (!ownerObjectId) {
      return res.status(400).json({ message: "Invalid authenticated user" });
    }

    const ownerIdStr = String(req.user.id); // âœ… canonical string
    const numericPrice = Number(price);

    if (!Number.isFinite(numericPrice) || numericPrice <= 0) {
      return res.status(400).json({ message: "Invalid price value" });
    }

    const role = (req.user.role || "").toLowerCase();
    const isSeller = role === "seller";
    const now = new Date();

    // === VALIDATIONS AGAINST CONFIG ===
    const maxTitleLen = limits.maxTitleLen ?? 120;
    const maxDescLen = limits.maxDescLen ?? 5000;
    const maxImages = limits.maxImages ?? 8;
    const maxVariants = limits.maxVariants ?? 20;
    const minPrice = pricing.minPrice ?? 0;
    const maxPrice = pricing.maxPrice ?? Number.MAX_SAFE_INTEGER;

    const cleanTitle = String(title).trim();
    const brandForSlug = req.body.brand || req.body.brandName;
    const variantForSlug = req.body.variant || req.body.shade;

    if (cleanTitle.length > maxTitleLen) {
      return res
        .status(400)
        .json({ message: `Title cannot exceed ${maxTitleLen} characters.` });
    }

    if (description && description.length > maxDescLen) {
      return res
        .status(400)
        .json({ message: `Description cannot exceed ${maxDescLen} characters.` });
    }

    const priceNum = Number(price);
    if (!Number.isFinite(priceNum) || priceNum < minPrice || priceNum > maxPrice) {
      return res.status(400).json({
        message: `Price must be between ${minPrice} and ${maxPrice}.`,
      });
    }

    if (
      pricing.requireCompareAtToBeHigher &&
      req.body.compareAtPrice != null &&
      Number(req.body.compareAtPrice) <= priceNum
    ) {
      return res.status(400).json({
        message: "Compare-at price must be greater than selling price.",
      });
    }

    if (Array.isArray(images) && images.length > maxImages) {
      return res
        .status(400)
        .json({ message: `Maximum ${maxImages} images allowed.` });
    }

    const variants = Array.isArray(req.body.variants) ? req.body.variants : [];
    if (variants.length > maxVariants) {
      return res
        .status(400)
        .json({ message: `Maximum ${maxVariants} variants allowed.` });
    }
    for (const v of variants) {
      if (v.price != null) {
        const vp = Number(v.price);
        if (!Number.isFinite(vp) || vp < minPrice || vp > maxPrice) {
          return res
            .status(400)
            .json({ message: `Variant prices must be between ${minPrice} and ${maxPrice}.` });
        }
        if (pricing.requireCompareAtToBeHigher && v.compareAtPrice != null) {
          if (Number(v.compareAtPrice) <= vp) {
            return res.status(400).json({
              message: "Variant compare-at price must be greater than selling price.",
            });
          }
        }
      }
    }

    // Shipping requirements
    if (shipping.requireWeight) {
      const w = Number(req.body.weight);
      if (!Number.isFinite(w) || w <= 0) {
        return res.status(400).json({ message: "Weight is required and must be greater than 0." });
      }
    }
    if (shipping.requireDimensions) {
      const l = Number(req.body.length);
      const w = Number(req.body.width);
      const h = Number(req.body.height);
      if (
        !Number.isFinite(l) ||
        !Number.isFinite(w) ||
        !Number.isFinite(h) ||
        l <= 0 ||
        w <= 0 ||
        h <= 0
      ) {
        return res
          .status(400)
          .json({ message: "Length, width and height are required and must be greater than 0." });
      }
    }

    // Moderation: banned words / blocked domains
    const bannedWords = content?.bannedWords || [];
    if (bannedWords.length) {
      const lowerName = cleanTitle.toLowerCase();
      const lowerDesc = (description || "").toLowerCase();
      for (const word of bannedWords) {
        const lw = String(word || "").toLowerCase();
        if (lw && (lowerName.includes(lw) || lowerDesc.includes(lw))) {
          return res
            .status(400)
            .json({ message: "Product contains prohibited content. Please review your title/description." });
        }
      }
    }
    const blockedDomains = content?.blockedDomains || [];
    if (blockedDomains.length && description) {
      const lowerDesc = description.toLowerCase();
      for (const domain of blockedDomains) {
        const d = String(domain || "").toLowerCase();
        if (d && lowerDesc.includes(d)) {
          return res
            .status(400)
            .json({ message: "Links to blocked domains are not allowed in the description." });
        }
      }
    }

    // Slug + title normalization
    const finalTitle = seo.appendBrandToTitle && brandForSlug
      ? `${cleanTitle} ${brandForSlug}`.trim()
      : cleanTitle;

    const slug = await generateUniqueProductSlug({
      title: finalTitle,
      brand: brandForSlug,
      variant: variantForSlug,
      providedSlug: req.body.slug,
    });

    const productQuantity = req.body.quantity != null ? Number(req.body.quantity) : 0;

    const product = {
      title: finalTitle,
      name: finalTitle,
      description,
      price: numericPrice,
      compareAtPrice:
        req.body.compareAtPrice != null ? Number(req.body.compareAtPrice) : null,
      costPrice: req.body.costPrice != null ? Number(req.body.costPrice) : null,
      category: category || "Uncategorized",
      brand: brandForSlug || req.body.brandName || "",
      variant: variantForSlug || "",
      location: location || "",
      condition: condition || "new",
      images: Array.isArray(images) ? images : [],
      slug,
      hasVariants: variants.length > 0,
      variants: variants.map((v) => ({
        name: (v.name || "").trim(),
        sku: (v.sku || "").trim(),
        price: v.price != null ? Number(v.price) : null,
        compareAtPrice: v.compareAtPrice != null ? Number(v.compareAtPrice) : null,
        quantity: v.quantity != null ? Number(v.quantity) : 0,
      })),
      quantity:
        variants.length > 0
          ? variants.reduce((sum, v) => sum + (Number(v.quantity) || 0), 0)
          : productQuantity,
      weight: req.body.weight != null ? Number(req.body.weight) : null,
      length: req.body.length != null ? Number(req.body.length) : null,
      width: req.body.width != null ? Number(req.body.width) : null,
      height: req.body.height != null ? Number(req.body.height) : null,

      // owner of the listing (who created it)
      userId: ownerObjectId,

      // âœ… seller mapping (string)
      sellerId: isSeller ? ownerIdStr : null,

      // Moderation / visibility
      status: isSeller
        ? moderation.requireApproval === false
          ? "approved"
          : "pending"
        : "approved",
      rejectionReason: null,
      reviewNotes: null,
      blocked: false,
      deleted: false,

      createdAt: now,
      updatedAt: now,
    };

    const result = await Products.insertOne(product);

    return res.json({
      message: isSeller
        ? "âœ… Product submitted for review"
        : "âœ… Product added and approved",
      productId: result.insertedId,
    });
  } catch (err) {
    console.error("Add product error:", err);
    return res
      .status(500)
      .json({ message: "Error adding product", error: err.message });
  }
}

/** âœ… New-style endpoint */
router.post("/products", authMiddleware, handleCreateProduct);
/** âœ… Backward-compatible endpoint */
router.post("/user/product", authMiddleware, handleCreateProduct);

/* =========================================================
   UPDATE PRODUCT
========================================================= */

/**
 * Seller updates their own product
 * PUT /api/products/:id
 * (Also backward compatible: PUT /api/user/product/:id)
 */
async function handleSellerUpdateProduct(req, res) {
  try {
    const id = toObjectId(req.params.id);
    if (!id) return res.status(400).json({ message: "Invalid product id" });

    const role = (req.user.role || "").toLowerCase();
    if (role !== "seller") {
      return res.status(403).json({ message: "Seller access only" });
    }

    const sellerId = String(req.user.id);

    // Block sensitive fields from seller updates
    const {
      sellerId: _sellerId,
      userId: _userId,
      status: incomingStatus,
      blocked: _blocked,
      deleted: _deleted,
      reviewedBy: _reviewedBy,
      reviewedAt: _reviewedAt,
      rejectionReason: _rejectionReason,
      reviewNotes: _reviewNotes,
      createdAt: _createdAt,
      ...safeBody
    } = req.body || {};

    // Fetch existing product to enforce ownership and compute slug
    const existing = await Products.findOne({
      _id: id,
      sellerId,
      deleted: { $ne: true },
    });

    if (!existing) {
      return res
        .status(404)
        .json({ message: "Product not found (or not yours)" });
    }

    // Validate/normalize
    if (safeBody.price != null) {
      const p = Number(safeBody.price);
      if (!Number.isFinite(p) || p <= 0) {
        return res.status(400).json({ message: "Invalid price value" });
      }
      safeBody.price = p;
    }

    if (safeBody.images != null && !Array.isArray(safeBody.images)) {
      safeBody.images = [];
    }

    const titleForSlug =
      typeof safeBody.title === "string" && safeBody.title.trim()
        ? safeBody.title.trim()
        : existing.title || existing.name;
    const brandForSlug =
      typeof safeBody.brand === "string" && safeBody.brand.trim()
        ? safeBody.brand.trim()
        : existing.brand;
    const variantForSlug =
      typeof safeBody.variant === "string" && safeBody.variant.trim()
        ? safeBody.variant.trim()
        : existing.variant;

    const needsSlugUpdate =
      !existing.slug ||
      safeBody.slug ||
      safeBody.title ||
      safeBody.brand ||
      safeBody.variant;

    const slugToSet = needsSlugUpdate
      ? await generateUniqueProductSlug({
          title: titleForSlug,
          brand: brandForSlug,
          variant: variantForSlug,
          providedSlug: safeBody.slug,
        })
      : existing.slug;

    // Prevent slug from being a random object on $set
    if ("slug" in safeBody) {
      delete safeBody.slug;
    }

    // Ownership check by sellerId (string)
    const result = await Products.findOneAndUpdate(
      { _id: id, sellerId, deleted: { $ne: true } },
      {
        $set: {
          ...safeBody,
          slug: slugToSet,
          updatedAt: new Date(),
          ...(incomingStatus === "draft" ? { status: "draft" } : {}),
        },
      },
      { returnDocument: "after" }
    );

    return res.json({ message: "Product updated", product: result.value });
  } catch (err) {
    console.error("PUT /products/:id (seller) error:", err);
    return res.status(500).json({ message: "Failed to update product" });
  }
}

router.put("/products/:id", authMiddleware, handleSellerUpdateProduct);
router.put("/user/product/:id", authMiddleware, handleSellerUpdateProduct);

/**
 * âœ… Admin updates any product
 * PUT /api/admin/product/:id
 */
router.put("/admin/product/:id", authMiddleware, async (req, res) => {
  try {
    if (!isAdminStaff(req.user)) {
      return res.status(403).json({ message: "Admins only" });
    }

    const id = toObjectId(req.params.id);
    if (!id) {
      return res.status(400).json({ message: "Invalid product id" });
    }
// PUT /api/admin/product/:id  (admin can edit any product)
router.put("/admin/product/:id", authMiddleware, async (req, res) => {
  try {
    if (!isAdminStaff(req.user)) {
      return res.status(403).json({ message: "Admins only" });
    }

    const pid = toObjectId(req.params.id);
    if (!pid) return res.status(400).json({ message: "Invalid product id" });

    const existing = await Products.findOne({ _id: pid });
    if (!existing) return res.status(404).json({ message: "Product not found" });

    // Never allow admin edit to change ownership links unless you explicitly want it
    const forbidden = ["userId", "sellerId", "_id", "createdAt", "reviewedBy", "reviewedAt"];
    forbidden.forEach((k) => {
      if (k in req.body) delete req.body[k];
    });

    const now = new Date();

    // Normalize name/title consistency
    const name = typeof req.body.name === "string" ? req.body.name.trim() : null;
    const title = typeof req.body.title === "string" ? req.body.title.trim() : null;
    const finalName = name || title || existing.name || existing.title || "";

    const brandForSlug =
      typeof req.body.brand === "string" && req.body.brand.trim()
        ? req.body.brand.trim()
        : existing.brand;
    const variantForSlug =
      typeof req.body.variant === "string" && req.body.variant.trim()
        ? req.body.variant.trim()
        : existing.variant;

    const needsSlugUpdate =
      req.body.slug ||
      !existing.slug ||
      req.body.title ||
      req.body.name ||
      req.body.brand ||
      req.body.variant;

    const slugToUse = needsSlugUpdate
      ? await generateUniqueProductSlug({
          title: finalName,
          brand: brandForSlug,
          variant: variantForSlug,
          providedSlug: req.body.slug,
        })
      : existing.slug;

    const patch = {
      ...req.body,

      // keep both fields aligned for legacy code
      name: finalName,
      title: finalName,
      slug: slugToUse,

      // normalize arrays
      images: Array.isArray(req.body.images) ? req.body.images : existing.images || [],

      // numeric fields
      price: req.body.price === null ? null : Number(req.body.price ?? existing.price ?? 0),
      quantity: req.body.quantity === null ? 0 : Number(req.body.quantity ?? existing.quantity ?? 0),
      costPrice: req.body.costPrice === null ? null : Number(req.body.costPrice ?? existing.costPrice ?? 0),
      compareAtPrice:
        req.body.compareAtPrice === null
          ? null
          : Number(req.body.compareAtPrice ?? existing.compareAtPrice ?? 0),

      blocked: typeof req.body.blocked === "boolean" ? req.body.blocked : !!existing.blocked,
      status: (req.body.status || existing.status || "pending").toLowerCase(),

      updatedAt: now,
    };

    await Products.updateOne({ _id: pid }, { $set: patch });

    const updated = await Products.findOne({ _id: pid });
    return res.json({ success: true, message: "Product updated", product: updated });
  } catch (err) {
    console.error("PUT /api/admin/product/:id error:", err);
    return res.status(500).json({ message: "Failed to update product" });
  }
});

    // Prevent silent ownership changes; keep this explicit via separate endpoint if needed
    const {
      sellerId: _sellerId,
      userId: _userId,
      createdAt: _createdAt,
      ...safeBody
    } = req.body || {};

    // Validate/normalize
    if (safeBody.price != null) {
      const p = Number(safeBody.price);
      if (!Number.isFinite(p) || p <= 0) {
        return res.status(400).json({ message: "Invalid price value" });
      }
      safeBody.price = p;
    }

    if (safeBody.images != null && !Array.isArray(safeBody.images)) {
      safeBody.images = [];
    }

    const now = new Date();

    const result = await Products.findOneAndUpdate(
      { _id: id, deleted: { $ne: true } },
      { $set: { ...safeBody, updatedAt: now } },
      { returnDocument: "after" }
    );

    if (!result.value) {
      return res.status(404).json({ message: "Product not found" });
    }

    return res.json({ message: "Product updated", product: result.value });
  } catch (err) {
    console.error("PUT /api/admin/product/:id error:", err);
    return res
      .status(500)
      .json({ message: "Failed to update product", error: err.message });
  }
});

/* =========================================================
   LIST PRODUCTS (PUBLIC, FILTERS, PAGINATION)
========================================================= */

/**
 * Core handler: list products with filters (PUBLIC)
 * - Only products that are:
 *   - NOT deleted
 *   - NOT blocked
 *   - status = "approved"
 *   (For existing legacy products without status, we treat them as approved)
 */
async function handleListProducts(req, res) {
  try {
    const page = Math.max(1, parseInt(req.query.page || "1", 10));
    const limitRaw = parseInt(req.query.limit || "0", 10);
    const limit = Number.isNaN(limitRaw) ? 0 : Math.max(0, limitRaw);

    const {
      category,
      categoryId,
      categorySlug,
      minPrice,
      maxPrice,
      sort,
      brand,
      brandSlug,
    } = req.query;

    const filter = {
      blocked: { $ne: true },
      deleted: { $ne: true },
      $or: [{ status: "approved" }, { status: { $exists: false } }],
    };

    const categoryQuery = categoryId || categorySlug || category;
    if (categoryQuery) {
      const normalized = String(categoryQuery).replace(/-/g, " ").trim();
      const raw = String(categoryQuery).trim();
      const categoryOr = [
        { category: { $regex: `^${escapeRegex(normalized)}$`, $options: "i" } },
        { category: { $regex: `^${escapeRegex(raw)}$`, $options: "i" } },
        { "category.name": { $regex: `^${escapeRegex(normalized)}$`, $options: "i" } },
        { "category.slug": { $regex: `^${escapeRegex(raw)}$`, $options: "i" } },
      ];
      const catId = toObjectId(categoryQuery);
      if (catId) {
        categoryOr.push({ categoryId: catId });
        categoryOr.push({ "category._id": catId });
      } else if (raw) {
        categoryOr.push({ categoryId: raw });
      }
      filter.$and = filter.$and || [];
      filter.$and.push({ $or: categoryOr });
    }

    // Brand filtering - match by slug or name
    const brandQuery = brandSlug || brand;
    if (brandQuery) {
      const normalized = String(brandQuery).replace(/-/g, " ").trim();
      const slugGuess = slugifyValue(normalized);
      const brandCandidates = new Set([normalized, String(brandQuery).trim()]);
      if (slugGuess) brandCandidates.add(slugGuess);

      let brandDoc = null;
      try {
        brandDoc = await Brands.findOne({
          $or: [
            { slug: { $regex: `^${escapeRegex(slugGuess)}$`, $options: "i" } },
            { slug: { $regex: `^${escapeRegex(String(brandQuery).trim())}`, $options: "i" } },
            { name: { $regex: `^${escapeRegex(normalized)}$`, $options: "i" } },
            { name: { $regex: escapeRegex(normalized), $options: "i" } },
          ],
        });
      } catch {
        // ignore brand lookup errors
      }

      if (brandDoc) {
        if (brandDoc.name) brandCandidates.add(String(brandDoc.name).trim());
        if (brandDoc.slug) brandCandidates.add(String(brandDoc.slug).trim());
      }

      const brandOr = [];
      brandCandidates.forEach((candidate) => {
        if (!candidate) return;
        const candidateNormalized = String(candidate).replace(/-/g, " ").trim();
        brandOr.push({
          brand: { $regex: `^${escapeRegex(candidateNormalized)}$`, $options: "i" },
        });
        if (candidateNormalized !== candidate) {
          brandOr.push({
            brand: { $regex: `^${escapeRegex(candidate)}$`, $options: "i" },
          });
        }
      });

      const looseSource = String(brandQuery).replace(/[^a-zA-Z0-9]/g, "");
      if (looseSource.length >= 3) {
        const loose = looseSource.split("").map(escapeRegex).join("\\W*");
        brandOr.push({ brand: { $regex: loose, $options: "i" } });
      }

      if (brandDoc?._id) {
        brandOr.push({ brandId: brandDoc._id });
      } else if (ObjectId.isValid(brandQuery)) {
        brandOr.push({ brandId: new ObjectId(brandQuery) });
      }

      filter.$and = filter.$and || [];
      filter.$and.push({ $or: brandOr });
    }

    const priceFilter = {};
    if (minPrice != null && minPrice !== "") priceFilter.$gte = Number(minPrice);
    if (maxPrice != null && maxPrice !== "") priceFilter.$lte = Number(maxPrice);
    if (Object.keys(priceFilter).length > 0) filter.price = priceFilter;

    const sortObj = {};
    if (sort === "low" || sort === "price_asc") sortObj.price = 1;
    else if (sort === "high" || sort === "price_desc") sortObj.price = -1;
    else if (sort === "popular") sortObj.soldCount = -1;
    else sortObj.createdAt = -1;

    const total = await Products.countDocuments(filter);

    let cursor = Products.find(filter).sort(sortObj);

    if (limit > 0) {
      const skip = (page - 1) * limit;
      cursor = cursor.skip(skip).limit(limit);
    }

    const products = await cursor.toArray();

    // Load brand info for products
    const brandIds = new Set();
    const brandNames = new Set();
    products.forEach((p) => {
      if (p.brandId && ObjectId.isValid(p.brandId)) brandIds.add(p.brandId.toString());
      if (p.brand) brandNames.add(p.brand.toLowerCase().trim());
    });

    const brandMap = new Map();
    if (brandIds.size > 0 || brandNames.size > 0) {
      const brandOr = [];
      if (brandIds.size > 0) {
        brandOr.push({ _id: { $in: [...brandIds].map((id) => new ObjectId(id)) } });
      }
      if (brandNames.size > 0) {
        [...brandNames].forEach((name) => {
          brandOr.push({ name: { $regex: `^${escapeRegex(name)}$`, $options: "i" } });
          brandOr.push({ slug: { $regex: `^${escapeRegex(name.replace(/\s+/g, "-"))}$`, $options: "i" } });
        });
      }
      const brands = await Brands.find({ $or: brandOr }).toArray();
      brands.forEach((b) => {
        brandMap.set(b._id.toString(), b);
        brandMap.set(b.name.toLowerCase().trim(), b);
        if (b.slug) brandMap.set(b.slug.toLowerCase().trim(), b);
      });
    }

    // Attach rating stats
    const productIds = products
      .map((p) => p._id)
      .filter((id) => id && ObjectId.isValid(id));

    let productsWithStats = products;

    if (productIds.length > 0) {
      const stats = await Reviews.aggregate([
        { $match: { productId: { $in: productIds }, status: "approved" } },
        {
          $group: {
            _id: "$productId",
            totalReviews: { $sum: 1 },
            sumRating: { $sum: "$rating" },
          },
        },
      ]).toArray();

      const statsMap = {};
      stats.forEach((s) => {
        const key = s._id.toString();
        const totalReviews = s.totalReviews || 0;
        const sumRating = s.sumRating || 0;
        const averageRating = totalReviews > 0 ? sumRating / totalReviews : 0;
        statsMap[key] = { averageRating, totalReviews };
      });

      productsWithStats = products.map((p) => {
        const key = p._id.toString();
        const s = statsMap[key] || { averageRating: 0, totalReviews: 0 };
        
        // Resolve brand info
        let brandInfo = null;
        if (p.brandId && brandMap.has(p.brandId.toString())) {
          brandInfo = brandMap.get(p.brandId.toString());
        } else if (p.brand && brandMap.has(p.brand.toLowerCase().trim())) {
          brandInfo = brandMap.get(p.brand.toLowerCase().trim());
        }
        
        return { 
          ...p, 
          averageRating: s.averageRating, 
          totalReviews: s.totalReviews,
          brandName: brandInfo?.name || p.brand || "",
          brandLogoUrl: brandInfo?.logoUrl || "",
        };
      });
    } else {
      // No reviews, still add brand info
      productsWithStats = products.map((p) => {
        let brandInfo = null;
        if (p.brandId && brandMap.has(p.brandId.toString())) {
          brandInfo = brandMap.get(p.brandId.toString());
        } else if (p.brand && brandMap.has(p.brand.toLowerCase().trim())) {
          brandInfo = brandMap.get(p.brand.toLowerCase().trim());
        }
        return {
          ...p,
          averageRating: 0,
          totalReviews: 0,
          brandName: brandInfo?.name || p.brand || "",
          brandLogoUrl: brandInfo?.logoUrl || "",
        };
      });
    }

    const totalPages = limit > 0 ? Math.ceil(total / limit) : 1;

    return res.json({ products: productsWithStats, total, page, totalPages });
  } catch (err) {
    console.error("Error fetching products:", err);
    return res
      .status(500)
      .json({ message: "Error fetching products", error: err.message });
  }
}

router.get("/products", handleListProducts);
router.get("/user/products", handleListProducts);

/* =========================================================
   GET SINGLE PRODUCT (PUBLIC)
========================================================= */

router.get("/products/:id", async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) return res.status(400).json({ message: "Invalid product id" });

    const product = await Products.findOne({
      _id: id,
      blocked: { $ne: true },
      deleted: { $ne: true },
      $or: [{ status: "approved" }, { status: { $exists: false } }],
    });

    if (!product) return res.status(404).json({ message: "Product not found" });

    await ensureProductHasSlug(product);
    const withStats = await attachProductStats(product);

    return res.json(withStats);
  } catch (err) {
    console.error("Error fetching product:", err);
    return res
      .status(500)
      .json({ message: "Error fetching product", error: err.message });
  }
});

// Public: get product by slug (fallback to id for legacy URLs)
router.get("/products/slug/:slug", async (req, res) => {
  try {
    const { slug } = req.params;

    const baseFilter = {
      blocked: { $ne: true },
      deleted: { $ne: true },
      $or: [{ status: "approved" }, { status: { $exists: false } }],
    };

    let product = await Products.findOne({ ...baseFilter, slug });

    if (!product && ObjectId.isValid(slug)) {
      const id = new ObjectId(slug);
      product = await Products.findOne({ ...baseFilter, _id: id });
    }

    if (!product) return res.status(404).json({ message: "Product not found" });

    await ensureProductHasSlug(product);
    const withStats = await attachProductStats(product);

    return res.json(withStats);
  } catch (err) {
    console.error("Error fetching product by slug:", err);
    return res
      .status(500)
      .json({ message: "Error fetching product", error: err.message });
  }
});

router.get("/pb/user/product/:id", async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) return res.status(400).json({ message: "Invalid product id" });

    const product = await Products.findOne({
      _id: id,
      blocked: { $ne: true },
      deleted: { $ne: true },
      $or: [{ status: "approved" }, { status: { $exists: false } }],
    });

    if (!product) return res.status(404).json({ message: "Product not found" });

    await ensureProductHasSlug(product);
    const withStats = await attachProductStats(product);

    return res.json(withStats);
  } catch (err) {
    console.error("Error fetching product:", err);
    return res
      .status(500)
      .json({ message: "Error fetching product", error: err.message });
  }
});

/* =========================================================
   MY PRODUCTS (OWNER â€“ SELLER OR CUSTOMER)
========================================================= */

async function handleMyProducts(req, res, userIdFromParam) {
  try {
    let userIdParam = userIdFromParam;

    if (userIdParam === "me" || !userIdParam) {
      userIdParam = req.user.id;
    }

    const ownerObjectId = toObjectId(userIdParam);
    if (!ownerObjectId) {
      return res.status(400).json({ message: "Invalid user id" });
    }

    const products = await Products.find({
      userId: ownerObjectId,
      deleted: { $ne: true },
    })
      .sort({ createdAt: -1 })
      .toArray();

    return res.json({ products });
  } catch (err) {
    console.error("Fetch my products error:", err);
    return res
      .status(500)
      .json({ message: "Error fetching products", error: err.message });
  }
}

router.get("/products/mine", authMiddleware, (req, res) =>
  handleMyProducts(req, res, "me")
);

router.get("/user/my-products/:userId", authMiddleware, (req, res) =>
  handleMyProducts(req, res, req.params.userId)
);

/* =========================================================
   ADMIN: PRODUCT LIST / APPROVE / REJECT / DELETE / BLOCK
========================================================= */

router.get("/admin/products", authMiddleware, async (req, res) => {
  try {
    if (!isAdminStaff(req.user)) {
      return res.status(403).json({ message: "Admins only" });
    }

    const { page = 1, limit = 20, status, search } = req.query;

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limitNum = Math.max(parseInt(limit, 10) || 20, 1);

    const filter = { deleted: { $ne: true } };

    if (status && ["approved", "pending", "rejected"].includes(status)) {
      filter.status = status;
    }

    if (search && search.trim()) {
      const term = search.trim();
      const regex = new RegExp(escapeRegex(term), "i");
      filter.$or = [
        { title: regex },
        { name: regex },
        { sku: regex },
        { barcode: regex },
        { category: regex },
        { categoryName: regex },
      ];
    }

    const total = await Products.countDocuments(filter);

    // âœ… Enhanced aggregation with seller info and inventory data
    const products = await Products.aggregate([
      { $match: filter },
      { $sort: { createdAt: -1 } },
      { $skip: (pageNum - 1) * limitNum },
      { $limit: limitNum },
      // Convert sellerId/userId to ObjectId for lookup
      {
        $addFields: {
          sellerObjId: {
            $convert: {
              input: { $ifNull: ["$sellerId", "$userId"] },
              to: "objectId",
              onError: null,
              onNull: null,
            },
          },
          // Normalize stock/quantity field
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
      // Lookup seller/user info
      {
        $lookup: {
          from: "users",
          localField: "sellerObjId",
          foreignField: "_id",
          as: "userDetails",
        },
      },
      { $unwind: { path: "$userDetails", preserveNullAndEmptyArrays: true } },
      // Add enriched fields
      {
        $addFields: {
          storeName: {
            $ifNull: [
              "$userDetails.storeName",
              { $ifNull: ["$userDetails.shopName", { $ifNull: ["$userDetails.name", "$userDetails.email"] }] },
            ],
          },
          sellerStoreName: {
            $ifNull: [
              "$userDetails.storeName",
              { $ifNull: ["$userDetails.shopName", { $ifNull: ["$userDetails.name", "$userDetails.email"] }] },
            ],
          },
          userName: "$userDetails.name",
          userEmail: "$userDetails.email",
          stock: "$_stock",
          quantity: "$_stock",
        },
      },
      // Project final fields
      {
        $project: {
          sellerObjId: 0,
          userDetails: 0,
          _stock: 0,
        },
      },
    ]).toArray();

    // Get sold quantities from orders
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

    return res.json({
      products: enrichedProducts,
      total,
      page: pageNum,
      limit: limitNum,
      totalPages: Math.max(Math.ceil(total / limitNum), 1),
    });
  } catch (err) {
    console.error("Admin products error:", err);
    return res
      .status(500)
      .json({ message: "Error fetching products", error: err.message });
  }
});

router.patch("/admin/product/:id/approve", authMiddleware, async (req, res) => {
  try {
    if (!isAdminStaff(req.user)) {
      return res.status(403).json({ message: "Admins only" });
    }

    const id = toObjectId(req.params.id);
    if (!id) return res.status(400).json({ message: "Invalid product id" });

    const { reviewNotes } = req.body || {};
    const now = new Date();

    const result = await Products.findOneAndUpdate(
      { _id: id, deleted: { $ne: true } },
      {
        $set: {
          status: "approved",
          rejectionReason: null,
          reviewNotes: reviewNotes || null,
          reviewedBy: req.user.id,
          reviewedAt: now,
          updatedAt: now,
        },
      },
      { returnDocument: "after" }
    );

    if (!result.value) return res.status(404).json({ message: "Product not found" });

    return res.json({ message: "Product approved successfully", product: result.value });
  } catch (err) {
    console.error("Approve product error:", err);
    return res
      .status(500)
      .json({ message: "Failed to approve product", error: err.message });
  }
});

router.patch("/admin/product/:id/reject", authMiddleware, async (req, res) => {
  try {
    if (!isAdminStaff(req.user)) {
      return res.status(403).json({ message: "Admins only" });
    }

    const id = toObjectId(req.params.id);
    if (!id) return res.status(400).json({ message: "Invalid product id" });

    const { reason, reviewNotes } = req.body || {};
    if (!reason || !reason.trim()) {
      return res.status(400).json({ message: "Rejection reason is required." });
    }

    const now = new Date();

    const result = await Products.findOneAndUpdate(
      { _id: id, deleted: { $ne: true } },
      {
        $set: {
          status: "rejected",
          rejectionReason: reason.trim(),
          reviewNotes: reviewNotes || null,
          reviewedBy: req.user.id,
          reviewedAt: now,
          updatedAt: now,
        },
      },
      { returnDocument: "after" }
    );

    if (!result.value) return res.status(404).json({ message: "Product not found" });

    return res.json({ message: "Product rejected successfully", product: result.value });
  } catch (err) {
    console.error("Reject product error:", err);
    return res
      .status(500)
      .json({ message: "Failed to reject product", error: err.message });
  }
});

router.delete("/admin/product/:id", authMiddleware, async (req, res) => {
  try {
    if (!isAdminStaff(req.user)) {
      return res.status(403).json({ message: "Admins only" });
    }

    const id = toObjectId(req.params.id);
    if (!id) return res.status(400).json({ message: "Invalid product id" });

    const now = new Date();

    const result = await Products.findOneAndUpdate(
      { _id: id, deleted: { $ne: true } },
      { $set: { deleted: true, status: "deleted", updatedAt: now } }
    );

    if (!result.value) return res.status(404).json({ message: "Product not found" });

    return res.json({ message: "Product deleted successfully" });
  } catch (err) {
    console.error("Delete product error:", err);
    return res
      .status(500)
      .json({ message: "Failed to delete product", error: err.message });
  }
});

router.put("/admin/product/:id/block", authMiddleware, async (req, res) => {
  try {
    if (!isAdminStaff(req.user)) {
      return res.status(403).json({ message: "Admins only" });
    }

    const id = toObjectId(req.params.id);
    if (!id) return res.status(400).json({ message: "Invalid product id" });

    const { block } = req.body;

    const result = await Products.updateOne(
      { _id: id, deleted: { $ne: true } },
      { $set: { blocked: !!block, updatedAt: new Date() } }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ message: "Product not found" });
    }

    return res.json({ message: block ? "Product blocked" : "Product unblocked" });
  } catch (err) {
    console.error("Block error:", err);
    return res
      .status(500)
      .json({ message: "Error updating product", error: err.message });
  }
});

router.get("/admin/product/:id", authMiddleware, async (req, res) => {
  try {
    if (!isAdminStaff(req.user)) {
      return res.status(403).json({ message: "Admins only" });
    }

    const id = toObjectId(req.params.id);
    if (!id) return res.status(400).json({ message: "Invalid product id" });

    const product = await Products.findOne({ _id: id });
    if (!product) return res.status(404).json({ message: "Product not found" });

    return res.json(product);
  } catch (err) {
    console.error("Get product error:", err);
    return res
      .status(500)
      .json({ message: "Error fetching product", error: err.message });
  }
});

/* =========================================================
   RECOMMENDATIONS
========================================================= */

router.get("/products/:id/recommendations", async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) return res.json([]);

    const product = await Products.findOne({ _id: id, deleted: { $ne: true } });
    if (!product) return res.json([]);

    const category = product.category;

    const filter = {
      _id: { $ne: id },
      blocked: { $ne: true },
      deleted: { $ne: true },
      $or: [{ status: "approved" }, { status: { $exists: false } }],
    };

    if (category) filter.category = category;

    const recs = await Products.find(filter, {
      projection: {
        title: 1,
        price: 1,
        images: 1,
        image: 1,
        featuredImage: 1,
        createdAt: 1,
      },
    })
      .sort({ createdAt: -1 })
      .limit(10)
      .toArray();

    return res.json(recs);
  } catch (err) {
    console.error("GET /products/:id/recommendations error:", err);
    return res.json([]);
  }
});

export default router;












