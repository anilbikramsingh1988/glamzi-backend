// routes/sellerRoutes.js
// All seller dashboard stuff:
// - Profile (personal + shop)
// - Products & inventory
// - Orders, payments, commissions, invoices

import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { ObjectId } from "mongodb";
import { getDB } from "../dbConfig.js";
import { authMiddleware } from "../middlewares/authMiddleware.js";

const router = express.Router();

// ================== FILE SYSTEM HELPERS ==================

// ESM __dirname fix
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ensure /uploads exist (for seller uploads: logos, avatar, docs)
const uploadsDir = path.join(__dirname, "..", "uploads");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Multer storage for general seller uploads (logos, avatar, docs)
const sellerStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const base = path.basename(file.originalname, ext);
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `seller-${base}-${unique}${ext}`);
  },
});

const uploadSeller = multer({ storage: sellerStorage });

// Multer storage for product images
const productImageStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const productImagesDir = path.join(uploadsDir, "products");
    if (!fs.existsSync(productImagesDir)) {
      fs.mkdirSync(productImagesDir, { recursive: true });
    }
    cb(null, productImagesDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const base = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9]/g, "_");
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `product-${base}-${unique}${ext}`);
  },
});

const uploadProductImages = multer({
  storage: productImageStorage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB max per file
  fileFilter: (req, file, cb) => {
    const allowedTypes = ["image/jpeg", "image/png", "image/webp", "image/gif"];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Only image files are allowed"), false);
    }
  },
});

// ================== DB & COLLECTIONS ==================

let Users;
let Products;
let SellerSettings;
let CategorySuggestions;
let BrandSuggestions;
let Orders;
let Invoices;
let CommissionSettings;
let Brands;
let ProductsConfig;
const PRODUCTS_CONFIG_ID = "products-config";

const collectionsReady = (async () => {
  const database = await getDB();
  Users = database.collection("users"); // sellers are users with role: "seller"
  Products = database.collection("products");
  SellerSettings = database.collection("seller_settings");
  CategorySuggestions = database.collection("categorySuggestions");
  BrandSuggestions = database.collection("brandSuggestions");
  Orders = database.collection("orders");
  Invoices = database.collection("invoices"); // ➜ persistent invoices (finance module)
  CommissionSettings = database.collection("commissionSettings"); // ➜ global commission config
  Brands = database.collection("brands");
  ProductsConfig = database.collection("productsConfig");
  return database;
})();

async function ensureCollectionsReady() {
  if (Users) return;
  await collectionsReady;
}

async function getProductConfig() {
  await ensureCollectionsReady();
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
      content: { bannedWords: [], blockedDomains: [] },
    };
  }
  return config;
}

// ================== HELPERS ==================

function ensureSeller(req, res, next) {
  const role = (req.user?.role || "").toLowerCase();
  if (role !== "seller") {
    return res.status(403).json({ message: "Seller access only" });
  }
  next();
}

function resolveSellerId(req) {
  return (
    req.user?.id ||
    req.user?._id ||
    req.user?.sellerId ||
    req.userId ||
    req.user?.userId ||
    null
  );
}

router.use(async (req, res, next) => {
  try {
    await ensureCollectionsReady();
    next();
  } catch (err) {
    next(err);
  }
});

// Seller-facing product configuration
router.get(
  "/seller/configuration/products",
  authMiddleware,
  ensureSeller,
  async (req, res) => {
    try {
      const config = await getProductConfig();
      return res.json({ success: true, config });
    } catch (err) {
      console.error("Seller product config load error:", err);
      return res
        .status(500)
        .json({ success: false, message: "Failed to load product configuration" });
    }
  }
);

function normalize(str) {
  return typeof str === "string" ? str.trim() : "";
}

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isNaN(n) ? fallback : n;
}

function escapeRegex(input = "") {
  return String(input).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeKey(v) {
  return String(v ?? "").trim().toLowerCase();
}

function toObjectIdSafe(id) {
  try {
    if (!id) return null;
    if (id instanceof ObjectId) return id;
    const s = String(id).trim();
    if (!ObjectId.isValid(s)) return null;
    return new ObjectId(s);
  } catch {
    return null;
  }
}

/**
 * Loads all needed brands for a list of products in one query.
 * Supports:
 * - product.brandId (preferred)
 * - product.brand (legacy name)
 */
async function loadBrandsForProducts(products = []) {
  await ensureCollectionsReady();
  const ids = new Set();
  const names = new Set();

  for (const p of products) {
    if (p?.brandId) {
      const oid = toObjectIdSafe(p.brandId);
      if (oid) ids.add(oid);
    }
    if (p?.brand) names.add(normalizeKey(p.brand));
  }

  const or = [];

  if (ids.size) {
    or.push({ _id: { $in: [...ids] } });
  }

  if (names.size) {
    // case-insensitive exact match for name
    const nameOr = [...names].map((nk) => ({
      name: { $regex: `^${escapeRegex(nk)}$`, $options: "i" },
    }));
    or.push(...nameOr);
  }

  if (!or.length) return new Map();

  // Only approved + active brands should be used
  const docs = await Brands.find({
    $or: or,
    status: "approved",
    isActive: true,
  }).toArray();

  const map = new Map();
  for (const b of docs) {
    map.set(String(b._id), b);
    map.set(normalizeKey(b.name), b);
    map.set(normalizeKey(b.slug), b);
  }

  return map;
}

/**
 * Resolves brand info for a product.
 * Returns: { _id, name, slug, logoUrl } or null
 */
function resolveBrandInfo(product, brandMap) {
  if (!product) return null;

  // 1) brandId (primary)
  if (product.brandId) {
    const oid = toObjectIdSafe(product.brandId);
    if (oid && brandMap.has(String(oid))) {
      const b = brandMap.get(String(oid));
      return { _id: b._id, name: b.name, slug: b.slug, logoUrl: b.logoUrl || "" };
    }
  }

  // 2) brand (name) fallback
  if (product.brand) {
    const key = normalizeKey(product.brand);
    if (brandMap.has(key)) {
      const b = brandMap.get(key);
      return { _id: b._id, name: b.name, slug: b.slug, logoUrl: b.logoUrl || "" };
    }
  }

  // 3) slug fallback (if product stores slug in brand field)
  if (product.brand) {
    const key = normalizeKey(product.brand);
    if (brandMap.has(key)) {
      const b = brandMap.get(key);
      return { _id: b._id, name: b.name, slug: b.slug, logoUrl: b.logoUrl || "" };
    }
  }

  // 4) legacy display-only
  if (product.brand) {
    return { _id: null, name: product.brand, slug: null, logoUrl: "" };
  }

  return null;
}

function extractCustomer(order) {
  const customerObj = order.customer || {};
  return {
    name: order.customerName || customerObj.name || "Customer",
    email: order.customerEmail || customerObj.email || "",
  };
}

function getDateRange(period, from, to) {
  const now = new Date();
  let start = null;
  let end = null;

  switch (period) {
    case "today": {
      start = new Date(now);
      start.setHours(0, 0, 0, 0);
      end = new Date(now);
      end.setHours(23, 59, 59, 999);
      break;
    }
    case "last7": {
      end = new Date(now);
      end.setHours(23, 59, 59, 999);
      start = new Date(end);
      start.setDate(end.getDate() - 6);
      start.setHours(0, 0, 0, 0);
      break;
    }
    case "last30": {
      end = new Date(now);
      end.setHours(23, 59, 59, 999);
      start = new Date(end);
      start.setDate(end.getDate() - 29);
      start.setHours(0, 0, 0, 0);
      break;
    }
    case "custom": {
      if (from) {
        const s = new Date(from);
        if (!Number.isNaN(s.getTime())) {
          s.setHours(0, 0, 0, 0);
          start = s;
        }
      }
      if (to) {
        const e = new Date(to);
        if (!Number.isNaN(e.getTime())) {
          e.setHours(23, 59, 59, 999);
          end = e;
        }
      }
      break;
    }
    case "all":
    default: {
      start = null;
      end = null;
      break;
    }
  }

  return { start, end };
}

// ================== SELLER PERSONAL PROFILE ==================
// GET  /api/seller/dashboard/profile
// PUT  /api/seller/dashboard/profile

router.get(
  "/seller/dashboard/profile",
  authMiddleware,
  ensureSeller,
  async (req, res) => {
    try {
      const sellerId = resolveSellerId(req);
      if (!sellerId) return res.status(401).json({ message: "Invalid seller session" });

      const oid = toObjectIdSafe(sellerId);
      const query = oid
        ? { $or: [{ _id: oid }, { sellerId: sellerId }] }
        : { $or: [{ sellerId: sellerId }] };

      const seller = await Users.findOne(query);

      if (!seller) {
        return res.status(404).json({ message: "Seller not found" });
      }

      const profile = {
        firstName: seller.firstName || seller.ownerFirstName || "",
        lastName: seller.lastName || seller.ownerLastName || "",
        phone: seller.phone || "",
        altPhone: seller.altPhone || "",
        email: seller.email || "",

        province: seller.province || "",
        district: seller.district || "",
        municipalityName: seller.municipalityName || "",
        wardNumber: seller.wardNumber || "",
        tole: seller.tole || "",
        streetAddress: seller.streetAddress || "",

        ownerIdType: seller.ownerIdType || "",
        ownerIdNumber: seller.ownerIdNumber || "",
        ownerIdDocumentUrl: seller.ownerIdDocumentUrl || "",

        avatarUrl: seller.avatarUrl || seller.avatar || "",
      };

      res.json({ profile });
    } catch (err) {
      console.error("Seller profile load error:", err);
      res.status(500).json({
        message: "Failed to load seller profile",
        error: err.message,
      });
    }
  }
);

router.put(
  "/seller/dashboard/profile",
  authMiddleware,
  ensureSeller,
  uploadSeller.fields([
    { name: "avatar", maxCount: 1 },
    { name: "ownerIdDocument", maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      const sellerId = resolveSellerId(req);
      if (!sellerId) return res.status(401).json({ message: "Invalid seller session" });

      const {
        firstName,
        lastName,
        phone,
        altPhone,
        email,

        province,
        district,
    municipalityName,
    wardNumber,
    tole,
    locationLat,
    locationLng,
        streetAddress,

        ownerIdType,
        ownerIdNumber,

        avatarRemoved,
      } = req.body;

      const files = req.files || {};

      const updateDoc = {
        firstName: firstName || "",
        lastName: lastName || "",
        phone: phone || "",
        altPhone: altPhone || "",
        // if you want to lock email, remove next line
        email: email || "",

        province: province || "",
        district: district || "",
        municipalityName: municipalityName || "",
        wardNumber: wardNumber || "",
        tole: tole || "",
        streetAddress: streetAddress || "",

        ownerIdType: ownerIdType || "",
        ownerIdNumber: ownerIdNumber || "",
      };

      // Location (only if provided)
      const hasLat = locationLat !== undefined && locationLat !== null && String(locationLat).trim() !== "";
      const hasLng = locationLng !== undefined && locationLng !== null && String(locationLng).trim() !== "";
      if (hasLat || hasLng) {
        const latNum = Number(locationLat);
        const lngNum = Number(locationLng);
        updateDoc.location = {
          lat: hasLat && Number.isFinite(latNum) ? latNum : null,
          lng: hasLng && Number.isFinite(lngNum) ? lngNum : null,
        };
      }

      // AVATAR
      if (files.avatar && files.avatar[0]) {
        const file = files.avatar[0];
        updateDoc.avatarUrl = `${req.protocol}://${req.get("host")}/uploads/${
          file.filename
        }`;
      } else if (avatarRemoved === "true") {
        updateDoc.avatarUrl = "";
      }

      // OWNER ID DOCUMENT
      if (files.ownerIdDocument && files.ownerIdDocument[0]) {
        const file = files.ownerIdDocument[0];
        updateDoc.ownerIdDocumentUrl = `${req.protocol}://${req.get(
          "host"
        )}/uploads/${file.filename}`;
      }

      const oid = toObjectIdSafe(sellerId);
      const query = oid
        ? { $or: [{ _id: oid }, { sellerId: sellerId }] }
        : { $or: [{ sellerId: sellerId }] };

      const result = await Users.findOneAndUpdate(
        query,
        { $set: updateDoc },
        { returnDocument: "after", upsert: true }
      );

      const seller = result.value || (await Users.findOne(query)) || updateDoc;

      const profile = {
        firstName: seller.firstName || "",
        lastName: seller.lastName || "",
        phone: seller.phone || "",
        altPhone: seller.altPhone || "",
        email: seller.email || "",
        province: seller.province || "",
        district: seller.district || "",
        municipalityName: seller.municipalityName || "",
        wardNumber: seller.wardNumber || "",
        tole: seller.tole || "",
        streetAddress: seller.streetAddress || "",
        ownerIdType: seller.ownerIdType || "",
        ownerIdNumber: seller.ownerIdNumber || "",
        ownerIdDocumentUrl: seller.ownerIdDocumentUrl || "",
        avatarUrl: seller.avatarUrl || "",
      };

      res.json({
        message: "Seller profile updated successfully",
        profile,
      });
    } catch (err) {
      console.error("Seller profile update error:", err);
      res.status(500).json({
        message: "Failed to save seller profile",
        error: err.message,
      });
    }
  }
);

// ================== SELLER SHOP PROFILE ==================
// GET  /api/seller/dashboard/shop-profile
// PUT  /api/seller/dashboard/shop-profile

router.get(
  "/seller/dashboard/shop-profile",
  authMiddleware,
  ensureSeller,
  async (req, res) => {
    try {
      const sellerId = req.user.id;

      const oid = toObjectIdSafe(sellerId);
      const query = oid
        ? { $or: [{ _id: oid }, { sellerId: sellerId }] }
        : { $or: [{ sellerId: sellerId }] };

      const seller = await Users.findOne(query);

      if (!seller) {
        // Graceful empty payload for first-time setup
        return res.json({ settings: {} });
      }

      const settings = {
        // Store identity
        storeName: seller.storeName || seller.shopName || "",
        ownerFirstName: seller.ownerFirstName || "",
        ownerLastName: seller.ownerLastName || "",
        ownerPhone: seller.ownerPhone || seller.phone || "",
        ownerEmail: seller.ownerEmail || seller.email || "",

        // Support
        supportEmail: seller.supportEmail || "",
        supportPhone: seller.supportPhone || "",
        supportWhatsapp: seller.supportWhatsapp || "",

        // Social media
        tiktokUrl: seller.tiktokUrl || "",
        facebookUrl: seller.facebookUrl || "",
        instagramUrl: seller.instagramUrl || "",

        // Owner ID
        ownerIdType: seller.ownerIdType || "",
        ownerIdNumber: seller.ownerIdNumber || "",
        ownerIdDocumentUrl: seller.ownerIdDocumentUrl || "",

        // Address
        province: seller.province || "",
        district: seller.district || "",
        municipalityName: seller.municipalityName || "",
        wardNumber: seller.wardNumber || "",
        tole: seller.tole || "",

        // Tax
        panNumber: seller.panNumber || "",
        panDocumentUrl: seller.panDocumentUrl || "",
        registrationCertificateUrl: seller.registrationCertificateUrl || "",
        bankChequeUrl: seller.bankChequeUrl || "",
        bankName: seller.bankName || "",
        branchName: seller.branchName || "",
        accountName: seller.accountName || "",
        accountNumber: seller.accountNumber || "",

        // Logo
        logoUrl: seller.logoUrl || "",

        // Localization
        defaultCurrency: seller.defaultCurrency || "NPR",
        defaultCountry: seller.defaultCountry || "Nepal",
        language: seller.language || "en",
        timezone: seller.timezone || "Asia/Kathmandu",
      };

      res.json({ settings });
    } catch (err) {
      console.error("Shop profile load error:", err);
      res.status(500).json({
        message: "Failed to load shop profile",
        error: err.message,
      });
    }
  }
);

router.put(
  "/seller/dashboard/shop-profile",
  authMiddleware,
  ensureSeller,
  uploadSeller.fields([
    { name: "logo", maxCount: 1 },
    { name: "panDocument", maxCount: 1 },
    { name: "registrationCertificate", maxCount: 1 },
    { name: "ownerIdDocument", maxCount: 1 },
    { name: "bankCheque", maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      const sellerId = resolveSellerId(req);
      if (!sellerId) return res.status(401).json({ message: "Invalid seller session" });

      const {
        // Store identity
        storeName,
        ownerFirstName,
        ownerLastName,
        ownerPhone,
        ownerEmail,

        // Support
        supportEmail,
        supportPhone,
        supportWhatsapp,

        // Social media
        tiktokUrl,
        facebookUrl,
        instagramUrl,

        // Owner ID
        ownerIdType,
        ownerIdNumber,

        // Address
        province,
        district,
        municipalityName,
        wardNumber,
        tole,
        locationLat,
        locationLng,

        // Tax
        panNumber,

        // Bank
        bankName,
        branchName,
        accountName,
        accountNumber,

        // Localization
        defaultCurrency,
        defaultCountry,
        language,
        timezone,

        // Flags
        logoRemoved,
      } = req.body;

      const files = req.files || {};

      const updateDoc = {
        // Store identity
        storeName: storeName || "",
        ownerFirstName: ownerFirstName || "",
        ownerLastName: ownerLastName || "",
        ownerPhone: ownerPhone || "",
        ownerEmail: ownerEmail || "",

        // Support
        supportEmail: supportEmail || "",
        supportPhone: supportPhone || "",
        supportWhatsapp: supportWhatsapp || "",

        // Social
        tiktokUrl: tiktokUrl || "",
        facebookUrl: facebookUrl || "",
        instagramUrl: instagramUrl || "",

        // Owner ID
        ownerIdType: ownerIdType || "",
        ownerIdNumber: ownerIdNumber || "",

        // Address
        province: province || "",
        district: district || "",
        municipalityName: municipalityName || "",
        wardNumber: wardNumber || "",
        tole: tole || "",

        // Tax
        panNumber: panNumber || "",

        // Bank
        bankName: bankName || "",
        branchName: branchName || "",
        accountName: accountName || "",
        accountNumber: accountNumber || "",

        // Localization
        defaultCurrency: defaultCurrency || "NPR",
        defaultCountry: defaultCountry || "Nepal",
        language: language || "en",
        timezone: timezone || "Asia/Kathmandu",
      };

      // Location (only if provided)
      const hasLat = locationLat !== undefined && locationLat !== null && String(locationLat).trim() !== "";
      const hasLng = locationLng !== undefined && locationLng !== null && String(locationLng).trim() !== "";
      if (hasLat || hasLng) {
        const latNum = Number(locationLat);
        const lngNum = Number(locationLng);
        updateDoc.location = {
          lat: hasLat && Number.isFinite(latNum) ? latNum : null,
          lng: hasLng && Number.isFinite(lngNum) ? lngNum : null,
        };
      }

      // LOGO
      if (files.logo && files.logo[0]) {
        const file = files.logo[0];
        updateDoc.logoUrl = `${req.protocol}://${req.get("host")}/uploads/${file.filename}`;
      } else if (logoRemoved === "true") {
        updateDoc.logoUrl = "";
      }

      // PAN DOCUMENT
      if (files.panDocument && files.panDocument[0]) {
        const file = files.panDocument[0];
        updateDoc.panDocumentUrl = `${req.protocol}://${req.get(
          "host"
        )}/uploads/${file.filename}`;
      }

      // REGISTRATION CERTIFICATE
      if (files.registrationCertificate && files.registrationCertificate[0]) {
        const file = files.registrationCertificate[0];
        updateDoc.registrationCertificateUrl = `${req.protocol}://${req.get(
          "host"
        )}/uploads/${file.filename}`;
      }

      // OWNER ID DOCUMENT
      if (files.ownerIdDocument && files.ownerIdDocument[0]) {
        const file = files.ownerIdDocument[0];
        updateDoc.ownerIdDocumentUrl = `${req.protocol}://${req.get(
          "host"
        )}/uploads/${file.filename}`;
      }

      // BANK CHEQUE / PROOF
      if (files.bankCheque && files.bankCheque[0]) {
        const file = files.bankCheque[0];
        updateDoc.bankChequeUrl = `${req.protocol}://${req.get(
          "host"
        )}/uploads/${file.filename}`;
      }

      const oid = toObjectIdSafe(sellerId);
      const query = oid
        ? { $or: [{ _id: oid }, { sellerId: sellerId }] }
        : { $or: [{ sellerId: sellerId }] };

      const result = await Users.findOneAndUpdate(
        query,
        { $set: updateDoc },
        { returnDocument: "after", upsert: true }
      );

      const seller = result.value || (await Users.findOne(query)) || updateDoc;

      const settings = {
        storeName: seller.storeName || "",
        ownerFirstName: seller.ownerFirstName || "",
        ownerLastName: seller.ownerLastName || "",
        ownerPhone: seller.ownerPhone || "",
        ownerEmail: seller.ownerEmail || "",
        supportEmail: seller.supportEmail || "",
        supportPhone: seller.supportPhone || "",
        supportWhatsapp: seller.supportWhatsapp || "",
        tiktokUrl: seller.tiktokUrl || "",
        facebookUrl: seller.facebookUrl || "",
        instagramUrl: seller.instagramUrl || "",
        ownerIdType: seller.ownerIdType || "",
        ownerIdNumber: seller.ownerIdNumber || "",
        ownerIdDocumentUrl: seller.ownerIdDocumentUrl || "",
        province: seller.province || "",
        district: seller.district || "",
        municipalityName: seller.municipalityName || "",
        wardNumber: seller.wardNumber || "",
        tole: seller.tole || "",
        locationLat: seller.location?.lat ?? seller.locationLat ?? null,
        locationLng: seller.location?.lng ?? seller.locationLng ?? null,
        panNumber: seller.panNumber || "",
        panDocumentUrl: seller.panDocumentUrl || "",
        registrationCertificateUrl: seller.registrationCertificateUrl || "",
        bankChequeUrl: seller.bankChequeUrl || "",
        bankName: seller.bankName || "",
        branchName: seller.branchName || "",
        accountName: seller.accountName || "",
        accountNumber: seller.accountNumber || "",
        logoUrl: seller.logoUrl || "",
        defaultCurrency: seller.defaultCurrency || "NPR",
        defaultCountry: seller.defaultCountry || "Nepal",
        language: seller.language || "en",
        timezone: seller.timezone || "Asia/Kathmandu",
      };

      res.json({
        message: "Shop profile updated successfully",
        settings,
      });
    } catch (err) {
      console.error("Shop profile update error:", err);
      res.status(500).json({
        message: "Failed to save shop profile",
        error: err.message,
      });
    }
  }
);

// ================== PUBLIC SELLER PROFILE ==================
// GET /api/seller/profile/public/:sellerId

router.get("/seller/profile/public/:sellerId", async (req, res) => {
  try {
    const { sellerId } = req.params;

    let query;
    if (ObjectId.isValid(sellerId)) {
      query = { _id: new ObjectId(sellerId) };
    } else {
      // optional handle based lookup if you add later
      query = { handle: sellerId };
    }

    const seller = await Users.findOne(query, {
      projection: { password: 0, resetToken: 0 },
    });

    if (!seller) {
      return res.status(404).json({ message: "Seller profile not found" });
    }

    const locationParts = [
      seller.tole,
      seller.municipalityName,
      seller.district,
      seller.province,
    ]
      .filter(Boolean)
      .join(", ");

    const profile = {
      id: seller._id,
      storeName: seller.storeName || seller.shopName || "",
      logoUrl: seller.logoUrl || "",
      location: locationParts,
      openSince: seller.openSince || seller.createdAt || null,
      verified: !!seller.verified,
      supportPhone: seller.supportPhone || seller.ownerPhone || "",
      supportEmail:
        seller.supportEmail || seller.ownerEmail || seller.email || "",
    };

    res.json(profile);
  } catch (err) {
    console.error("Public seller profile error:", err);
    res.status(500).json({
      message: "Error fetching public seller profile",
      error: err.message,
    });
  }
});

// ================== PUBLIC SELLER SHIPPING SETTINGS ==================
// GET /api/seller/settings/shipping/public/:sellerId
router.get("/seller/settings/shipping/public/:sellerId", async (req, res) => {
  try {
    const { sellerId } = req.params || {};
    if (!sellerId) {
      return res.status(400).json({ message: "sellerId is required" });
    }

    const sellerIdStr = String(sellerId);
    const filters = [{ sellerId: sellerIdStr }];
    if (ObjectId.isValid(sellerIdStr)) {
      filters.push({ sellerId: new ObjectId(sellerIdStr) });
    }

    const settings = await SellerSettings.findOne({ $or: filters });
    return res.json({ settings: settings?.shipping || {} });
  } catch (err) {
    console.error("Public seller shipping settings error:", err);
    return res.status(500).json({ message: "Failed to load shipping settings" });
  }
});

// ================== SELLER PRODUCTS & INVENTORY ==================
// Base: /api/seller/products, /api/seller/inventory, /api/seller/suggestions/*

// ➜ UPDATED: seller products now returns brandInfo (name + logoUrl)
router.get("/seller/products", authMiddleware, ensureSeller, async (req, res) => {
  try {
    const sellerId = req.user.id;

    const products = await Products.find({
      userId: sellerId,
      deleted: { $ne: true },
    })
      .sort({ createdAt: -1 })
      .toArray();

    const brandMap = await loadBrandsForProducts(products);

    const enriched = products.map((p) => ({
      ...p,
      brandInfo: resolveBrandInfo(p, brandMap),
    }));

    res.json({ products: enriched });
  } catch (err) {
    console.error("Seller products error:", err);
    res.status(500).json({ message: "Error fetching seller products" });
  }
});

// ➜ UPDATED: Barcode lookup also returns brandLogoUrl
router.get(
  "/seller/products/barcode/:barcode",
  authMiddleware,
  ensureSeller,
  async (req, res) => {
    try {
      const { barcode } = req.params;

      const product = await Products.findOne({
        barcode,
        deleted: { $ne: true },
      });

      if (!product) {
        return res.status(404).json({ message: "No product found" });
      }

      const brandMap = await loadBrandsForProducts([product]);
      const brandInfo = resolveBrandInfo(product, brandMap);

      res.json({
        product: {
          name: product.name || product.title || "",
          category: product.category || "",
          brand: brandInfo?.name || product.brand || "",
          brandId: brandInfo?._id || product.brandId || null,
          brandLogoUrl: brandInfo?.logoUrl || "",
          description: product.description || "",
          image: (product.images && product.images[0]) || "",
        },
      });
    } catch (err) {
      console.error("Barcode lookup error:", err);
      res.status(500).json({ message: "Barcode lookup failed" });
    }
  }
);

// Upload product images (returns URLs for use in product creation)
router.post(
  "/seller/uploads/images",
  authMiddleware,
  ensureSeller,
  uploadProductImages.array("images", 8),
  async (req, res) => {
    try {
      if (!req.files || req.files.length === 0) {
        return res.status(400).json({ message: "No images uploaded" });
      }

      const imageUrls = req.files.map(
        (file) => `/uploads/products/${file.filename}`
      );

      res.json({
        success: true,
        images: imageUrls,
        message: `${imageUrls.length} image(s) uploaded successfully`,
      });
    } catch (err) {
      console.error("Image upload error:", err);
      res.status(500).json({ message: "Failed to upload images" });
    }
  }
);

// Add product (validates against admin configuration)
router.post(
  "/seller/products",
  authMiddleware,
  ensureSeller,
  async (req, res) => {
    try {
      const {
        barcode,
        name,
        category,
        brand,
        brandId,
        price,
        quantity,
        description,
        image,
        images: imageArray,
        costPrice,
        compareAtPrice,
        hasVariants,
        variants,
        weight,
        length,
        width,
        height,
      } = req.body;

      if (!barcode || !name || !category || !price || !quantity) {
        return res.status(400).json({ message: "Required fields missing" });
      }

      // ➜ Fetch and validate against admin configuration
      const config = await getProductConfig();
      const { limits, pricing, moderation, content } = config;

      // Validate title length
      if (name.trim().length > limits.maxTitleLen) {
        return res.status(400).json({
          message: `Product name cannot exceed ${limits.maxTitleLen} characters.`,
        });
      }

      // Validate description length
      if (description && description.length > limits.maxDescLen) {
        return res.status(400).json({
          message: `Description cannot exceed ${limits.maxDescLen} characters.`,
        });
      }

      // Validate images count
      const allImages = imageArray || (image ? [image] : []);
      if (allImages.length > limits.maxImages) {
        return res.status(400).json({
          message: `Maximum ${limits.maxImages} images allowed.`,
        });
      }

      // Validate variants count
      if (hasVariants && Array.isArray(variants) && variants.length > limits.maxVariants) {
        return res.status(400).json({
          message: `Maximum ${limits.maxVariants} variants allowed.`,
        });
      }

      // Validate price range
      const priceNum = Number(price);
      if (priceNum < pricing.minPrice || priceNum > pricing.maxPrice) {
        return res.status(400).json({
          message: `Price must be between ${pricing.minPrice} and ${pricing.maxPrice} ${pricing.defaultCurrency}.`,
        });
      }

      // Validate compareAtPrice
      if (pricing.requireCompareAtToBeHigher && compareAtPrice && price) {
        if (Number(compareAtPrice) <= Number(price)) {
          return res.status(400).json({
            message: "Compare at price must be higher than the selling price.",
          });
        }
      }

      // Check banned words in name and description
      if (content?.bannedWords?.length > 0) {
        const lowerName = name.toLowerCase();
        const lowerDesc = (description || "").toLowerCase();
        for (const word of content.bannedWords) {
          const lowerWord = word.toLowerCase();
          if (lowerName.includes(lowerWord) || lowerDesc.includes(lowerWord)) {
            return res.status(400).json({
              message:
                "Product contains prohibited content. Please review your title and description.",
            });
          }
        }
      }

      // Check blocked domains inside description (basic substring check)
      if (content?.blockedDomains?.length > 0 && description) {
        const lowerDesc = description.toLowerCase();
        for (const domain of content.blockedDomains) {
          if (lowerDesc.includes(domain.toLowerCase())) {
            return res.status(400).json({
              message:
                "Links to blocked domains are not allowed in product description.",
            });
          }
        }
      }

      // Shipping requirements
      if (config.shipping?.requireWeight) {
        const weightNum = Number(weight);
        if (!Number.isFinite(weightNum) || weightNum <= 0) {
          return res.status(400).json({
            message: "Weight is required and must be greater than 0.",
          });
        }
      }

      if (config.shipping?.requireDimensions) {
        const len = Number(length);
        const wid = Number(width);
        const hei = Number(height);
        if (
          !Number.isFinite(len) ||
          !Number.isFinite(wid) ||
          !Number.isFinite(hei) ||
          len <= 0 ||
          wid <= 0 ||
          hei <= 0
        ) {
          return res.status(400).json({
            message:
              "Length, width and height are required and must be greater than 0.",
          });
        }
      }

      const now = new Date();

      const productDoc = {
        barcode,
        title: name,
        name,
        category,
        brand: brand || "",
        brandId: brandId || null,
        description: description || "",
        price: priceNum,
        quantity: Number(quantity),
        costPrice: costPrice ? Number(costPrice) : null,
        compareAtPrice: compareAtPrice ? Number(compareAtPrice) : null,
        images: allImages,
        hasVariants: Boolean(hasVariants),
        variants: hasVariants && Array.isArray(variants) ? variants : [],
        weight: weight ? Number(weight) : null,
        dimensions:
          length || width || height
            ? {
                length: length ? Number(length) : null,
                width: width ? Number(width) : null,
                height: height ? Number(height) : null,
              }
            : null,
        userId: req.user.id,
        status: moderation?.requireApproval ? "pending" : "active",
        blocked: false,
        deleted: false,
        createdAt: now,
        updatedAt: now,
      };

      const result = await Products.insertOne(productDoc);

      res.json({
        message: moderation?.requireApproval
          ? "➜ Product added successfully and pending approval"
          : "➜ Product added successfully",
        productId: result.insertedId,
      });
    } catch (err) {
      console.error("Add product error:", err);
      res.status(500).json({ message: "Error adding product" });
    }
  }
);

// ➜ UPDATED: Get single product for edit includes brandInfo
router.get("/seller/products/:id", authMiddleware, ensureSeller, async (req, res) => {
  try {
    const { id } = req.params;

    const pid = toObjectIdSafe(id);
    if (!pid) return res.status(400).json({ message: "Invalid product ID" });

    const product = await Products.findOne({
      _id: pid,
      userId: req.user.id,
      deleted: { $ne: true },
    });

    if (!product) {
      return res.status(404).json({ message: "Product not found" });
    }

    const brandMap = await loadBrandsForProducts([product]);

    res.json({
      product: {
        ...product,
        brandInfo: resolveBrandInfo(product, brandMap),
      },
    });
  } catch (err) {
    res.status(500).json({ message: "Error loading product" });
  }
});

// Update product (validates against admin configuration)
router.put("/seller/products/:id", authMiddleware, ensureSeller, async (req, res) => {
  try {
    const { id } = req.params;
    const {
      name,
      description,
      images,
      price,
      compareAtPrice,
      variants,
      weight,
      length,
      width,
      height,
    } = req.body;

    // ➜ Fetch and validate against admin configuration
    const config = await getProductConfig();
    const { limits, pricing, content } = config;

    // Validate title length
    if (name && name.trim().length > limits.maxTitleLen) {
      return res.status(400).json({
        message: `Product name cannot exceed ${limits.maxTitleLen} characters.`,
      });
    }

    // Validate description length
    if (description && description.length > limits.maxDescLen) {
      return res.status(400).json({
        message: `Description cannot exceed ${limits.maxDescLen} characters.`,
      });
    }

    // Validate images count
    if (images && Array.isArray(images) && images.length > limits.maxImages) {
      return res.status(400).json({
        message: `Maximum ${limits.maxImages} images allowed.`,
      });
    }

    // Validate variants count
    if (variants && Array.isArray(variants) && variants.length > limits.maxVariants) {
      return res.status(400).json({
        message: `Maximum ${limits.maxVariants} variants allowed.`,
      });
    }

    // Validate price range
    if (price) {
      const priceNum = Number(price);
      if (priceNum < pricing.minPrice || priceNum > pricing.maxPrice) {
        return res.status(400).json({
          message: `Price must be between ${pricing.minPrice} and ${pricing.maxPrice} ${pricing.defaultCurrency}.`,
        });
      }
    }

    // Validate compareAtPrice
    if (pricing.requireCompareAtToBeHigher && compareAtPrice && price) {
      if (Number(compareAtPrice) <= Number(price)) {
        return res.status(400).json({
          message: "Compare at price must be higher than the selling price.",
        });
      }
    }

    // Check banned words
    if (content?.bannedWords?.length > 0) {
      const lowerName = (name || "").toLowerCase();
      const lowerDesc = (description || "").toLowerCase();
      for (const word of content.bannedWords) {
        const lowerWord = word.toLowerCase();
        if (lowerName.includes(lowerWord) || lowerDesc.includes(lowerWord)) {
          return res.status(400).json({
            message:
              "Product contains prohibited content. Please review your title and description.",
          });
        }
      }
    }

    // Check blocked domains
    if (content?.blockedDomains?.length > 0 && description) {
      const lowerDesc = description.toLowerCase();
      for (const domain of content.blockedDomains) {
        if (lowerDesc.includes(domain.toLowerCase())) {
          return res.status(400).json({
            message:
              "Links to blocked domains are not allowed in product description.",
          });
        }
      }
    }

    // Shipping requirements
    if (config.shipping?.requireWeight) {
      const weightNum = Number(weight);
      if (!Number.isFinite(weightNum) || weightNum <= 0) {
        return res.status(400).json({
          message: "Weight is required and must be greater than 0.",
        });
      }
    }

    if (config.shipping?.requireDimensions) {
      const len = Number(length);
      const wid = Number(width);
      const hei = Number(height);
      if (
        !Number.isFinite(len) ||
        !Number.isFinite(wid) ||
        !Number.isFinite(hei) ||
        len <= 0 ||
        wid <= 0 ||
        hei <= 0
      ) {
        return res.status(400).json({
          message:
            "Length, width and height are required and must be greater than 0.",
        });
      }
    }

    const updateDoc = {
      ...req.body,
      updatedAt: new Date(),
    };

    if (weight !== undefined) {
      updateDoc.weight = weight ? Number(weight) : null;
    }
    if (length !== undefined || width !== undefined || height !== undefined) {
      updateDoc.dimensions = {
        length: length ? Number(length) : null,
        width: width ? Number(width) : null,
        height: height ? Number(height) : null,
      };
    }

    if (updateDoc.price) updateDoc.price = Number(updateDoc.price);
    if (updateDoc.quantity) updateDoc.quantity = Number(updateDoc.quantity);
    if (updateDoc.costPrice) updateDoc.costPrice = Number(updateDoc.costPrice);
    if (updateDoc.compareAtPrice)
      updateDoc.compareAtPrice = Number(updateDoc.compareAtPrice);
    if (updateDoc.name) {
      updateDoc.title = updateDoc.name;
    }
    if (Array.isArray(updateDoc.images) && updateDoc.images.length > 0) {
      delete updateDoc.image;
    } else if (updateDoc.image) {
      updateDoc.images = [updateDoc.image];
      delete updateDoc.image;
    }

    const result = await Products.updateOne(
      { _id: new ObjectId(id), userId: req.user.id },
      { $set: updateDoc }
    );

    if (!result.matchedCount) {
      return res.status(404).json({ message: "Product not found" });
    }

    res.json({ message: "➜ Product updated successfully" });
  } catch (err) {
    console.error("Update product error:", err);
    res.status(500).json({ message: "Error updating product" });
  }
});

// Delete product (kept as-is)
router.delete(
  "/seller/products/:id",
  authMiddleware,
  ensureSeller,
  async (req, res) => {
    try {
      const { id } = req.params;

      const result = await Products.deleteOne({
        _id: new ObjectId(id),
        userId: req.user.id,
      });

      if (!result.deletedCount) {
        return res.status(404).json({ message: "Product not found" });
      }

      res.json({ message: "✅ Product deleted successfully" });
    } catch (err) {
      res.status(500).json({ message: "Error deleting product" });
    }
  }
);

// ➜ UPDATED: Inventory includes brandName + brandLogoUrl from DB
router.get("/seller/inventory", authMiddleware, ensureSeller, async (req, res) => {
  try {
    const products = await Products.find({
      userId: req.user.id,
      deleted: { $ne: true },
    }).toArray();

    const brandMap = await loadBrandsForProducts(products);

    let totalSkus = products.length;
    let totalUnits = 0;
    let lowStockCount = 0;
    let outOfStockCount = 0;

    products.forEach((p) => {
      const qty = Number(p.quantity || 0);
      totalUnits += qty;
      if (qty <= 0) outOfStockCount++;
      else if (qty <= 5) lowStockCount++;
    });

    const items = products.map((p) => {
      const brandInfo = resolveBrandInfo(p, brandMap);
      return {
        _id: p._id,
        name: p.name,
        barcode: p.barcode,
        category: p.category,

        // ➜ resolved brand
        brandId: brandInfo?._id || p.brandId || null,
        brandName: brandInfo?.name || p.brand || "",
        brandLogoUrl: brandInfo?.logoUrl || "",

        quantity: p.quantity,
        price: p.price,
        costPrice: p.costPrice,
        status: p.status,
        updatedAt: p.updatedAt,
      };
    });

    res.json({
      summary: { totalSkus, totalUnits, lowStockCount, outOfStockCount },
      items,
    });
  } catch (err) {
    console.error("Inventory error:", err);
    res.status(500).json({ message: "Error loading inventory" });
  }
});

// ================== SELLER ORDERS / PAYMENTS / COMMISSIONS / INVOICES ==================
// Base: /api/seller/orders...

// Orders listing
router.get("/seller/orders", authMiddleware, ensureSeller, async (req, res) => {
  try {
    const sellerId = req.user.id;
    const sellerIdStr = String(sellerId);

    // Find orders where at least one item belongs to this seller
    const cursor = Orders.find({
      $or: [
        { sellerId: sellerId },
        { sellerId: sellerIdStr },
        { "items.sellerId": sellerId },
        { "items.sellerId": sellerIdStr },
        { "items.userId": sellerId },
        { "items.userId": sellerIdStr },
      ],
    }).sort({ createdAt: -1 });
    const docs = await cursor.toArray();

    const orders = docs.map((order) => {
      const { name, email } = extractCustomer(order);

      const items = Array.isArray(order.items) ? order.items : [];
      const itemCount =
        items.length > 0
          ? items.reduce((sum, item) => sum + (item.quantity || 0), 0)
          : order.itemCount || 0;

      const totalRaw = order.totalAmount ?? order.grandTotal ?? order.subtotal ?? 0;
      const totalAmount =
        typeof totalRaw === "number" ? totalRaw : Number(totalRaw) || 0;

      return {
        _id: order._id,
        orderNumber: order.orderNumber || order.invoiceNumber || null,
        customerName: name,
        customerEmail: email,
        items,
        itemCount,
        totalAmount,
        totals: order.totals || {
          subtotal: order.subtotal || totalAmount,
          shipping: order.shippingFee || order.shippingCost || 0,
          discount: order.discount || 0,
          grandTotal: totalAmount,
        },
        status: order.status || "pending",
        paymentStatus: order.paymentStatus || order.payment?.status || "pending",
        paymentMethod: order.paymentMethod || order.payment?.method || null,
        shippingAddress: order.shippingAddress || order.shipping || null,
        shippingMeta: order.shippingMeta || null,
        notes: order.notes || order.customerNotes || null,
        createdAt: order.createdAt || order.created_at || null,
        paidAt:
          order.paidAt || order.payment?.paidAt || order.payment?.paid_at || null,
      };
    });

    res.json({ orders });
  } catch (err) {
    console.error("Seller orders error:", err);
    res.status(500).json({
      message: "Error fetching seller orders",
      error: err.message,
    });
  }
});

// Draft orders
router.get(
  "/seller/orders/drafts",
  authMiddleware,
  ensureSeller,
  async (req, res) => {
    try {
      const sellerId = resolveSellerId(req);
      if (!sellerId) return res.status(401).json({ message: "Invalid seller session" });

      const draftStatuses = ["draft", "pending", "sent", "converted", "cancelled"];

      const cursor = Orders.find({
        sellerId,
        $or: [
          { isDraft: true },
          { draft: true },
          { orderType: "draft" },
          { status: { $in: draftStatuses } },
        ],
      }).sort({ updatedAt: -1, createdAt: -1 });

      const docs = await cursor.toArray();

      const drafts = docs.map((order) => {
        const { name, email } = extractCustomer(order);

        const items = Array.isArray(order.items) ? order.items : [];
        const itemCount =
          items.length > 0
            ? items.reduce((sum, item) => sum + (item.quantity || 0), 0)
            : order.itemCount || 0;

        const totalRaw = order.totalAmount ?? order.grandTotal ?? order.subtotal ?? 0;
        const totalAmount =
          typeof totalRaw === "number" ? totalRaw : Number(totalRaw) || 0;

        return {
          _id: order._id,
          draftNumber: order.draftNumber || order.orderNumber || order.invoiceNumber || null,
          customerName: name,
          customerEmail: email || null,
          status: order.status || "draft",
          items,
          itemCount,
          totalAmount,
          notes: order.notes || order.note || null,
          createdAt: order.createdAt || order.created_at || null,
          updatedAt:
            order.updatedAt || order.updated_at || order.modifiedAt || null,
        };
      });

      res.json({ drafts });
    } catch (err) {
      console.error("Seller draft orders error:", err);
      res.status(500).json({
        message: "Error fetching draft orders",
        error: err.message,
      });
    }
  }
);

// Payments
router.get(
  "/seller/orders/payments",
  authMiddleware,
  ensureSeller,
  async (req, res) => {
    try {
      const sellerId = req.user.id;

      const cursor = Orders.find({ sellerId }).sort({ createdAt: -1 });
      const docs = await cursor.toArray();

      const payments = docs.map((order) => {
        const { name, email } = extractCustomer(order);

        const p = order.payment || {};

        const amountRaw = p.amount ?? order.totalAmount ?? order.grandTotal ?? 0;
        const amount =
          typeof amountRaw === "number" ? amountRaw : Number(amountRaw) || 0;

        const paymentMethod = normalize(p.method || order.paymentMethod) || "COD";
        const paymentStatus =
          normalize(p.status || order.paymentStatus) || "pending";

        return {
          _id: order._id,
          orderId: order._id,
          orderNumber: order.orderNumber || order.invoiceNumber || null,
          customerName: name,
          customerEmail: email || null,
          amount,
          paymentMethod,
          paymentStatus,
          transactionId: p.transactionId || p.txnId || p.refId || null,
          reference: p.reference || p.note || null,
          paidAt: p.paidAt || p.paid_at || order.paidAt || null,
          createdAt: order.createdAt || order.created_at || null,
        };
      });

      res.json({ payments });
    } catch (err) {
      console.error("Seller payments error:", err);
      res.status(500).json({
        message: "Error fetching order payments",
        error: err.message,
      });
    }
  }
);

// Commissions (aligned with global admin commission settings) ✅ UPDATED ONLY THIS ROUTE
// (kept exactly as you pasted)
router.get(
  "/orders/seller/commissions",
  authMiddleware,
  ensureSeller,
  async (req, res) => {
    try {
      const sellerId = req.user.id;
      const { period = "last30", from, to, status = "all", method = "all" } = req.query;

      const { start, end } = getDateRange(period, from, to);

      // ✅ Use invoices as source of truth for commissions
      const invQuery = { sellerId };

      // Prefer invoiceDate, fallback to createdAt
      if (start || end) {
        const dateFilter = {};
        if (start) dateFilter.$gte = start;
        if (end) dateFilter.$lte = end;

        invQuery.$or = [{ invoiceDate: dateFilter }, { createdAt: dateFilter }];
      }

      if (status && status !== "all") {
        invQuery.status = {
          $regex: `^${escapeRegex(status)}$`,
          $options: "i",
        };
      }

      if (method && method !== "all") {
        const rx = { $regex: `^${escapeRegex(method)}$`, $options: "i" };
        invQuery.$or = invQuery.$or || [];
        invQuery.$or.push({ paymentMethod: rx }, { paymentMode: rx });
      }

      // ✅ Load commission settings (admin commonly uses _id: "default")
      const settingsDoc = await CommissionSettings.findOne({ _id: "default" });

      const global = settingsDoc?.settings?.global || {
        rateType: "percentage", // "percentage" | "flat"
        rate: 10,
        applyOn: "product-price", // "product-price" | "product-price-with-tax" | "subtotal-with-shipping"
      };

      const applyOn = String(global.applyOn || "product-price");
      const defaultRateType = String(global.rateType || "percentage").toLowerCase();
      const defaultRate = toNumber(global.rate, 0);

      const docs = await Invoices.find(invQuery)
        .sort({ createdAt: -1 })
        .toArray();

      const commissions = [];
      let totalInvoices = 0;
      let grossSalesBase = 0; // base used for commission
      let totalCommission = 0;
      let netPayout = 0;

      for (const inv of docs) {
        const items = Array.isArray(inv.items) ? inv.items : [];

        // ✅ Compute subtotal from invoice items (matches your invoice schema)
        const itemsSubtotal = items.reduce((sum, it) => {
          const price = toNumber(it?.price, 0);
          const qty = toNumber(it?.quantity, 1);
          return sum + price * qty;
        }, 0);

        // Optional future-safe fallbacks
        const taxAmount =
          toNumber(inv.taxAmount, NaN) ??
          toNumber(inv.taxTotal, NaN) ??
          toNumber(inv.tax, NaN) ??
          toNumber(inv.vat, 0);

        const shippingAmount =
          toNumber(inv.shippingAmount, NaN) ??
          toNumber(inv.shippingFee, NaN) ??
          toNumber(inv.shipping, 0);

        let baseAmount = itemsSubtotal;

        if (applyOn === "product-price-with-tax") {
          baseAmount = itemsSubtotal + taxAmount;
        } else if (applyOn === "subtotal-with-shipping") {
          baseAmount = itemsSubtotal + taxAmount + shippingAmount;
        }

        // ✅ If you later store commission snapshot in invoice, prefer it
        const snapRateType = String(
          inv?.commission?.rateType || defaultRateType
        ).toLowerCase();
        const snapRate = toNumber(inv?.commission?.rate, defaultRate);

        let commissionAmount = toNumber(inv?.commission?.amount, NaN);
        if (!Number.isFinite(commissionAmount)) {
          if (snapRateType === "percentage") {
            commissionAmount = (baseAmount * snapRate) / 100;
          } else {
            commissionAmount = snapRate; // flat per invoice/order
          }
        }

        // ✅ Invoice schema uses totalAmount
        const totalAmount = toNumber(inv.totalAmount, baseAmount);
        const payoutAmount = totalAmount - commissionAmount;

        const createdAt = inv.invoiceDate || inv.createdAt || null;

        commissions.push({
          _id: inv._id,
          invoiceId: inv._id,
          invoiceNumber: inv.invoiceNumber || null,
          orderId: inv.orderId || null,
          orderNumber: inv.orderNumber || null,

          customerName: inv?.customer?.name || "Customer",
          customerEmail: inv?.customer?.email || "",
          customerPhone: inv?.customer?.phone || "",

          grossAmount: baseAmount,
          commissionRate: snapRate,
          rateType: snapRateType,
          commissionAmount,
          payoutAmount,

          currency: inv.currency || "NPR",
          status: inv.status || "issued",
          paymentMethod: inv.paymentMethod || null,

          createdAt,
          paidAt: inv.paidAt || null,
        });

        totalInvoices += 1;
        grossSalesBase += baseAmount;
        totalCommission += commissionAmount;
        netPayout += payoutAmount;
      }

      const summary = {
        totalInvoices,
        grossSales: grossSalesBase,
        totalCommission,
        netPayout,
      };

      res.json({ commissions, summary });
    } catch (err) {
      console.error("Seller commissions error:", err);
      res.status(500).json({
        message: "Error fetching order commissions",
        error: err.message,
      });
    }
  }
);

/**
 * ==============================
 * SELLER INVOICES LIST (NEW)
 * ==============================
 * GET /api/orders/seller/invoices
 * Query params:
 *  - page, limit
 *  - q (search in invoiceNumber/orderNumber/orderId/customer)
 *  - status (issued/paid/pending/cancelled/refunded)
 *  - period (today/last7/last30/all/custom)
 *  - from, to (YYYY-MM-DD when period=custom)
 *
 * Response:
 * {
 *   invoices: [...],
 *   summary: { total, paid, pending, cancelled, refunded, issued, totalAmount },
 *   pagination: { page, pages, total }
 * }
 */
router.get(
  "/orders/seller/invoices",
  authMiddleware,
  ensureSeller,
  async (req, res) => {
    try {
      const sellerId = req.user.id;
      const sellerIdStr = String(sellerId);

      const {
        page = 1,
        limit = 10,
        q = "",
        status = "",
        period = "last30",
        from = "",
        to = "",
      } = req.query;

      const pageNum = Number(page) > 0 ? Number(page) : 1;
      const limitNum = Number(limit) > 0 ? Number(limit) : 10;

      const filters = [
        {
          // invoices should store sellerId as string, but be defensive
          $or: [{ sellerId: sellerIdStr }, { sellerId }],
        },
      ];

      // Date filter
      const { start, end } = getDateRange(period, from, to);
      if (start || end) {
        const dateFilter = {};
        if (start) dateFilter.$gte = start;
        if (end) dateFilter.$lte = end;

        filters.push({
          $or: [{ invoiceDate: dateFilter }, { createdAt: dateFilter }],
        });
      }

      // Status filter
      if (status && String(status).trim() !== "") {
        filters.push({
          status: {
            $regex: `^${escapeRegex(status.trim())}$`,
            $options: "i",
          },
        });
      }

      // Search filter
      if (q && String(q).trim() !== "") {
        const rx = new RegExp(escapeRegex(String(q).trim()), "i");
        filters.push({
          $or: [
            { invoiceNumber: rx },
            { orderNumber: rx },
            { orderId: rx },
            { "customer.name": rx },
            { "customer.email": rx },
          ],
        });
      }

      const query = filters.length > 1 ? { $and: filters } : filters[0];

      const moneyNum = (v) => {
        const n = Number(v);
        return Number.isFinite(n) ? n : 0;
      };

      // Load all matching invoices (volume is low initially; can move to aggregation later)
      const allDocs = await Invoices.find(query)
        .sort({ invoiceDate: -1, createdAt: -1 })
        .toArray();

      const totalCount = allDocs.length;
      const totalPages =
        totalCount === 0 ? 1 : Math.max(1, Math.ceil(totalCount / limitNum));

      const safePage = Math.min(pageNum, totalPages);
      const startIndex = (safePage - 1) * limitNum;
      const endIndex = startIndex + limitNum;

      const pageDocs = allDocs.slice(startIndex, endIndex);

      // Summary across all matching invoices
      const summary = allDocs.reduce(
        (acc, inv) => {
          const totalAmount =
            moneyNum(inv?.totals?.grandTotal) ||
            moneyNum(inv?.orderTotals?.grandTotal) ||
            moneyNum(inv?.totalAmount) ||
            moneyNum(inv?.grandTotal) ||
            moneyNum(inv?.totals?.total) ||
            moneyNum(inv?.total);

          acc.total += 1;
          acc.totalAmount += totalAmount;

          const st = String(inv.status || "").toLowerCase();
          if (st === "paid") acc.paid += 1;
          else if (st === "issued") acc.issued += 1;
          else if (st === "pending") acc.pending += 1;
          else if (st === "cancelled") acc.cancelled += 1;
          else if (st === "refunded") acc.refunded += 1;

          return acc;
        },
        {
          total: 0,
          paid: 0,
          pending: 0,
          cancelled: 0,
          refunded: 0,
          issued: 0,
          totalAmount: 0,
        }
      );

      // Map page docs into frontend shape
      const invoices = pageDocs.map((inv) => {
        const totalAmount =
          moneyNum(inv?.totals?.grandTotal) ||
          moneyNum(inv?.orderTotals?.grandTotal) ||
          moneyNum(inv?.totalAmount) ||
          moneyNum(inv?.grandTotal) ||
          moneyNum(inv?.totals?.total) ||
          moneyNum(inv?.total);

        const currency =
          inv?.totals?.currency || inv?.orderTotals?.currency || inv?.currency || "NPR";

        const customerName =
          inv?.customer?.name ||
          inv?.buyer?.name ||
          inv?.customerName ||
          inv?.shippingAddress?.fullName ||
          inv?.shippingAddress?.name ||
          null;
        const customerEmail =
          inv?.customer?.email ||
          inv?.buyer?.email ||
          inv?.customerEmail ||
          null;

        return {
          _id: inv?._id,
          invoiceNumber: inv?.invoiceNumber || null,
          invoiceDate: inv?.invoiceDate || inv?.createdAt || null,
          orderId: inv?.orderId || null,
          orderNumber: inv?.orderNumber || null,
          status: inv?.status || "issued",
          totalAmount,
          currency,
          customer: {
            name: customerName,
            email: customerEmail,
          },
          items: inv?.items || [],
        };
      });

      return res.json({
        invoices,
        summary,
        pagination: {
          page: safePage,
          pages: totalPages,
          total: totalCount,
        },
        total: totalCount,
      });
    } catch (err) {
      console.error("Seller invoices error:", err);
      res.status(500).json({
        message: "Error fetching order invoices",
        error: err.message,
      });
    }
  }
);

// Earnings summary (mobile/web) with filters
router.get(
  "/seller/earnings/summary",
  authMiddleware,
  ensureSeller,
  async (req, res) => {
    try {
      const sellerId = req.user.id;
      const sellerIdStr = String(sellerId);
      const { period = "last30", status = "all", method = "all", from, to } =
        req.query;
      const { start, end } = getDateRange(period, from, to);
      const now = new Date();

      const sellerMatch = {
        $or: [
          { sellerId: sellerId },
          { sellerId: sellerIdStr },
          { "items.sellerId": sellerId },
          { "items.sellerId": sellerIdStr },
          { "items.userId": sellerId },
          { "items.userId": sellerIdStr },
        ],
      };

      const filters = [sellerMatch];

      if (start || end) {
        const dateFilter = {};
        if (start) dateFilter.$gte = start;
        if (end) dateFilter.$lte = end;
        filters.push({
          $or: [
            { createdAt: dateFilter },
            { created_at: dateFilter },
            { orderDate: dateFilter },
          ],
        });
      }

      if (status && status !== "all") {
        const rx = { $regex: `^${escapeRegex(status)}$`, $options: "i" };
        filters.push({ status: rx });
      }

      if (method && method !== "all") {
        const rx = { $regex: `^${escapeRegex(method)}$`, $options: "i" };
        filters.push({
          $or: [{ paymentMethod: rx }, { paymentMode: rx }],
        });
      }

      const query = filters.length > 1 ? { $and: filters } : sellerMatch;
      const orders = await Orders.find(query).toArray();

      const orderIdStrings = orders
        .map((o) => String(o?._id || o?.id || ""))
        .filter(Boolean);
      const orderIdObjects = orderIdStrings
        .map((id) => toObjectIdSafe(id))
        .filter(Boolean);

      // Look up invoices for these orders to honor commissionPayout.status when settlements run
      const invoiceFilters = [
        {
          $or: [{ sellerId: sellerId }, { sellerId: sellerIdStr }],
        },
        {
          $or: [
            { orderId: { $in: orderIdObjects } },
            { orderId: { $in: orderIdStrings } },
          ],
        },
      ];

      const invoiceQuery =
        invoiceFilters.length > 1 ? { $and: invoiceFilters } : invoiceFilters[0];

      const invoices = await Invoices.find(invoiceQuery).toArray();
      const invoiceStatusByOrder = new Map();
      invoices.forEach((inv) => {
        const key = String(inv.orderId || inv._id || "").trim();
        if (!key) return;
        const st = String(
          inv?.commissionPayout?.status || inv?.status || "pending"
        ).toLowerCase();
        invoiceStatusByOrder.set(key, st);
      });

      let totalSalesRevenue = 0;
      let netEarnings = 0;
      let unsettledEarnings = 0;
      let availableForWithdrawal = 0;
      let upcomingSettlementAmount = 0;
      let pendingCodAmount = 0;
      let refundedDeductions = 0;
      let commissionDeductions = 0;
      let totalPaidToDate = 0;
      let payoutsThisMonth = 0;
      let failedCount = 0;
      let chargesTotals = {
        total: 0,
        sellerViolations: 0,
        shippingPenalties: 0,
        packagingCharges: 0,
        marketingParticipationFee: 0,
      };

      const isDelivered = (statusVal = "") => {
        const s = String(statusVal).toLowerCase();
        return ["delivered", "completed", "shipped", "fulfilled"].includes(s);
      };

      const isSellerItem = (item = {}) => {
        const sid = item.sellerId || item.userId;
        return sid && String(sid) === sellerIdStr;
      };

      for (const order of orders) {
        const items = Array.isArray(order.items) ? order.items : [];
        const sellerItems = items.filter(isSellerItem);

        const orderTotal = toNumber(
          order.totalAmount ?? order.grandTotal ?? order.subtotal,
          0
        );

        const itemsGross = sellerItems.reduce((sum, it) => {
          const qty = toNumber(it.quantity ?? 1, 1);
          const price = toNumber(
            it.price ?? it.rate ?? it.unitPrice ?? it.amount,
            0
          );
          const line = toNumber(
            it.total ??
              it.totalAmount ??
              it.subtotal ??
              it.lineTotal ??
              price * qty,
            price * qty
          );
          return sum + line;
        }, 0);

        const gross = itemsGross > 0 ? itemsGross : orderTotal;
        const share = orderTotal > 0 ? gross / orderTotal : 1;

        const commissionFromItems = sellerItems.reduce(
          (sum, it) =>
            sum + toNumber(it.commissionAmount ?? it.commission ?? it.fee, 0),
          0
        );
        const commission =
          sellerItems.length > 0
            ? commissionFromItems
            : toNumber(
                order.commissionAmount ??
                  order.commission ??
                  order.fees?.commission,
                0
              ) * share;

        const paymentFees = toNumber(
          order.paymentFees ?? order.fees?.payment,
          0
        ) * share;
        const discount =
          toNumber(order.discountTotal ?? order.discount, 0) * share;
        const refunded =
          toNumber(order.refundTotal ?? order.refundedAmount, 0) * share;
        const adjustments =
          toNumber(order.charges?.total ?? order.chargesTotal, 0) * share;

        totalSalesRevenue += gross;
        refundedDeductions += refunded;
        commissionDeductions += commission;
        chargesTotals.total += adjustments;

        chargesTotals.sellerViolations +=
          toNumber(order.charges?.sellerViolations, 0) * share;
        chargesTotals.shippingPenalties +=
          toNumber(order.charges?.shippingPenalties, 0) * share;
        chargesTotals.packagingCharges +=
          toNumber(order.charges?.packagingCharges, 0) * share;
        chargesTotals.marketingParticipationFee +=
          toNumber(order.charges?.marketingParticipationFee, 0) * share;

        const net =
          gross - commission - paymentFees - discount - refunded - adjustments;
        netEarnings += net;

        const invoicePayoutStatus =
          invoiceStatusByOrder.get(String(order._id || order.id || "")) || "";

        const paidOut =
          String(order.payoutStatus || "").toLowerCase() === "paid" ||
          String(order.commissionPayout?.status || "").toLowerCase() ===
            "paid" ||
          invoicePayoutStatus === "paid";
        if (isDelivered(order.status) && !paidOut) {
          unsettledEarnings += net;
        }

        const methodVal = String(
          order.paymentMethod || order.paymentMode || ""
        ).toLowerCase();
        const paid =
          String(order.paymentStatus || "").toLowerCase() === "paid";
        if (methodVal === "cod" && !paid) {
          pendingCodAmount += gross;
        }

        if (paidOut) {
          totalPaidToDate += net;
          const createdDate =
            order.createdAt ||
            order.created_at ||
            order.orderDate ||
            order.updatedAt ||
            null;
          const d = createdDate ? new Date(createdDate) : null;
          if (d && !Number.isNaN(d.getTime())) {
            if (
              d.getUTCFullYear() === now.getUTCFullYear() &&
              d.getUTCMonth() === now.getUTCMonth()
            ) {
              payoutsThisMonth += net;
            }
          }
        }

        const payoutStatus = String(
          order.payoutStatus || order.commissionPayout?.status || ""
        ).toLowerCase();
        if (payoutStatus === "failed" || payoutStatus === "rejected") {
          failedCount += 1;
        }
      }

      availableForWithdrawal = Math.max(0, unsettledEarnings * 0.5);
      upcomingSettlementAmount = Math.max(
        0,
        unsettledEarnings - availableForWithdrawal
      );

      return res.json({
        success: true,
        data: {
          totalSalesRevenue,
          netEarnings,
          unsettledEarnings,
          availableForWithdrawal,
          upcomingSettlementAmount,
          pendingCodAmount,
          refundedDeductions,
          commissionDeductions,
          totalPaidToDate,
          payoutsThisMonth,
          failedCount,
          chargesAdjustments: chargesTotals,
        },
      });
    } catch (err) {
      console.error("Seller earnings summary error:", err);
      res
        .status(500)
        .json({ success: false, message: "Failed to fetch earnings summary." });
    }
  }
);

// Payouts list (derived from orders + commission snapshots)
router.get("/seller/payouts", authMiddleware, ensureSeller, async (req, res) => {
  try {
    const sellerId = req.user.id;
    const sellerIdStr = String(sellerId);
    const {
      status = "all",
      from,
      to,
      min,
      max,
      method = "all",
      page = 1,
      limit = 50,
    } = req.query;

    const filters = [
      {
        $or: [
          { sellerId: sellerId },
          { sellerId: sellerIdStr },
          { "items.sellerId": sellerId },
          { "items.sellerId": sellerIdStr },
          { "items.userId": sellerId },
          { "items.userId": sellerIdStr },
        ],
      },
    ];

    if (from || to) {
      const dateFilter = {};
      if (from) dateFilter.$gte = new Date(from);
      if (to) dateFilter.$lte = new Date(to);
      filters.push({
        $or: [
          { payoutPaidAt: dateFilter },
          { updatedAt: dateFilter },
          { createdAt: dateFilter },
        ],
      });
    }

    if (status && status !== "all") {
      filters.push({
        $or: [
          {
            payoutStatus: {
              $regex: `^${escapeRegex(status)}$`,
              $options: "i",
            },
          },
          {
            "commissionPayout.status": {
              $regex: `^${escapeRegex(status)}$`,
              $options: "i",
            },
          },
        ],
      });
    }

    if (method && method !== "all") {
      filters.push({
        $or: [
          {
            paymentMethod: {
              $regex: `^${escapeRegex(method)}$`,
              $options: "i",
            },
          },
          {
            paymentMode: {
              $regex: `^${escapeRegex(method)}$`,
              $options: "i",
            },
          },
        ],
      });
    }

    const query = filters.length > 1 ? { $and: filters } : filters[0];
    const cursor = Orders.find(query).sort({ createdAt: -1 });
    const orders = await cursor.toArray();

    const payouts = [];
    const minAmount = Number(min) || null;
    const maxAmount = Number(max) || null;

    for (const order of orders) {
      const items = Array.isArray(order.items) ? order.items : [];
      const sellerItems = items.filter((it) => {
        const sid = it.sellerId || it.userId;
        return sid && String(sid) === sellerIdStr;
      });

      const orderTotal = toNumber(
        order.totalAmount ?? order.grandTotal ?? order.subtotal,
        0
      );
      const itemsGross = sellerItems.reduce((sum, it) => {
        const qty = toNumber(it.quantity ?? 1, 1);
        const price = toNumber(
          it.price ?? it.rate ?? it.unitPrice ?? it.amount,
          0
        );
        const line = toNumber(
          it.total ??
            it.totalAmount ??
            it.subtotal ??
            it.lineTotal ??
            price * qty,
          price * qty
        );
        return sum + line;
      }, 0);
      const gross = itemsGross > 0 ? itemsGross : orderTotal;
      const share = orderTotal > 0 ? gross / orderTotal : 1;

      const commissionFromItems = sellerItems.reduce(
        (sum, it) =>
          sum + toNumber(it.commissionAmount ?? it.commission ?? it.fee, 0),
        0
      );
      const commission =
        sellerItems.length > 0
          ? commissionFromItems
          : toNumber(
              order.commissionAmount ??
                order.commission ??
                order.fees?.commission,
              0
            ) * share;

      const paymentFees = toNumber(
        order.paymentFees ?? order.fees?.payment,
        0
      ) * share;
      const discount =
        toNumber(order.discountTotal ?? order.discount, 0) * share;
      const refunded =
        toNumber(order.refundTotal ?? order.refundedAmount, 0) * share;
      const adjustments =
        toNumber(order.charges?.total ?? order.chargesTotal, 0) * share;

      const net =
        gross - commission - paymentFees - discount - refunded - adjustments;
      const payoutStatus = String(
        order.payoutStatus || order.commissionPayout?.status || "pending"
      ).toLowerCase();

      if (minAmount !== null && net < minAmount) continue;
      if (maxAmount !== null && net > maxAmount) continue;

      const bankName =
        order.payout?.bankName ||
        order.payout?.destination ||
        order.bankName ||
        order.paymentProvider ||
        "Bank";
      const account = order.payout?.account || order.account || null;
      const maskedAccount = account
        ? `****${String(account).slice(-4)}`
        : order.payout?.maskedAccount || "****";

      payouts.push({
        payoutId:
          order.commissionPayout?.batchId ||
          order.payout?.batchId ||
          order._id,
        orderId: order._id,
        amount: net,
        currency: order.currency || "NPR",
        payoutStatus,
        createdAt:
          order.payoutPaidAt || order.updatedAt || order.createdAt || null,
        reference:
          order.commissionPayout?.ref ||
          order.commissionPayout?.reference ||
          order.payout?.reference ||
          order.paymentReference ||
          null,
        bankName,
        maskedAccount,
        ordersCovered: 1,
        note: order.payout?.note || order.note || null,
      });
    }

    // basic pagination
    const pageNum = Number(page) || 1;
    const limitNum = Number(limit) || 50;
    const startIdx = (pageNum - 1) * limitNum;
    const endIdx = startIdx + limitNum;

    const paged = payouts.slice(startIdx, endIdx);

    return res.json({
      success: true,
      data: {
        payouts: paged,
        page: pageNum,
        total: payouts.length,
        hasMore: endIdx < payouts.length,
      },
    });
  } catch (err) {
    console.error("Seller payouts list error:", err);
    res
      .status(500)
      .json({ success: false, message: "Failed to load payouts." });
  }
});

// Payout detail (derived from single order / batch id)
router.get(
  "/seller/payouts/:id",
  authMiddleware,
  ensureSeller,
  async (req, res) => {
    try {
      const sellerId = req.user.id;
      const sellerIdStr = String(sellerId);
      const { id } = req.params;

      const matchId = (() => {
        try {
          return new ObjectId(id);
        } catch {
          return null;
        }
      })();

      const order = await Orders.findOne({
        $and: [
          {
            $or: [
              { _id: matchId },
              { "commissionPayout.batchId": id },
              { "payout.batchId": id },
              { orderId: id },
            ],
          },
          {
            $or: [
              { sellerId: sellerId },
              { sellerId: sellerIdStr },
              { "items.sellerId": sellerId },
              { "items.sellerId": sellerIdStr },
              { "items.userId": sellerId },
              { "items.userId": sellerIdStr },
            ],
          },
        ],
      });

      if (!order) {
        return res
          .status(404)
          .json({ success: false, message: "Payout not found." });
      }

      const items = Array.isArray(order.items) ? order.items : [];
      const sellerItems = items.filter((it) => {
        const sid = it.sellerId || it.userId;
        return sid && String(sid) === sellerIdStr;
      });

      const orderTotal = toNumber(
        order.totalAmount ?? order.grandTotal ?? order.subtotal,
        0
      );
      const itemsGross = sellerItems.reduce((sum, it) => {
        const qty = toNumber(it.quantity ?? 1, 1);
        const price = toNumber(
          it.price ?? it.rate ?? it.unitPrice ?? it.amount,
          0
        );
        const line = toNumber(
          it.total ??
            it.totalAmount ??
            it.subtotal ??
            it.lineTotal ??
            price * qty,
          price * qty
        );
        return sum + line;
      }, 0);
      const gross = itemsGross > 0 ? itemsGross : orderTotal;
      const share = orderTotal > 0 ? gross / orderTotal : 1;

      const commissionFromItems = sellerItems.reduce(
        (sum, it) =>
          sum + toNumber(it.commissionAmount ?? it.commission ?? it.fee, 0),
        0
      );
      const commission =
        sellerItems.length > 0
          ? commissionFromItems
          : toNumber(
              order.commissionAmount ??
                order.commission ??
                order.fees?.commission,
              0
            ) * share;

      const paymentFees = toNumber(
        order.paymentFees ?? order.fees?.payment,
        0
      ) * share;
      const discount =
        toNumber(order.discountTotal ?? order.discount, 0) * share;
      const refunded =
        toNumber(order.refundTotal ?? order.refundedAmount, 0) * share;
      const adjustments =
        toNumber(order.charges?.total ?? order.chargesTotal, 0) * share;

      const net =
        gross - commission - paymentFees - discount - refunded - adjustments;
      const payoutStatus = String(
        order.payoutStatus || order.commissionPayout?.status || "pending"
      ).toLowerCase();

      const bankName =
        order.payout?.bankName ||
        order.payout?.destination ||
        order.bankName ||
        order.paymentProvider ||
        "Bank";
      const account = order.payout?.account || order.account || null;
      const maskedAccount = account
        ? `****${String(account).slice(-4)}`
        : order.payout?.maskedAccount || "****";

      const response = {
        success: true,
        data: {
          payoutId:
            order.commissionPayout?.batchId ||
            order.payout?.batchId ||
            order._id,
          orderId: order._id,
          amount: net,
          currency: order.currency || "NPR",
          payoutStatus,
          createdAt:
            order.payoutPaidAt || order.updatedAt || order.createdAt || null,
          reference:
            order.commissionPayout?.ref ||
            order.commissionPayout?.reference ||
            order.payout?.reference ||
            order.paymentReference ||
            null,
          bankName,
          maskedAccount,
          ordersCovered: 1,
          note: order.payout?.note || order.note || null,
          breakdown: {
            gross,
            netEarnings: net,
            commissionDeductions: commission,
            refunds: refunded,
            paymentFees,
            discount,
            adjustments,
            payoutAmount: net,
          },
          orders: [
            {
              orderId: order._id,
              orderNumber:
                order.orderNumber || order.invoiceNumber || order._id,
              deliveredAt:
                order.deliveredAt || order.updatedAt || order.createdAt || null,
              grossAmount: gross,
              commissionRate:
                order.commissionRate ??
                order.fees?.commissionRate ??
                (gross > 0 ? ((commission / gross) * 100).toFixed(2) : 0),
              commissionAmount: commission,
              netEarnings: net,
              refundFlag: refunded > 0,
              status: order.status || "pending",
            },
          ],
        },
      };

      return res.json(response);
    } catch (err) {
      console.error("Seller payout detail error:", err);
      res
        .status(500)
        .json({ success: false, message: "Failed to load payout detail." });
    }
  }
);

// Single order details (keep after specific paths)
router.get(
  "/seller/orders/:id",
  authMiddleware,
  ensureSeller,
  async (req, res) => {
    try {
      const sellerId = req.user.id;
      const sellerIdStr = String(sellerId);
      const { id } = req.params;

      let _id;
      try {
        _id = new ObjectId(id);
      } catch {
        return res.status(400).json({ message: "Invalid order ID" });
      }

      // Find order where seller ID matches (on order or on items)
      const order = await Orders.findOne({
        _id,
        $or: [
          { sellerId: sellerId },
          { sellerId: sellerIdStr },
          { "items.sellerId": sellerId },
          { "items.sellerId": sellerIdStr },
          { "items.userId": sellerId },
          { "items.userId": sellerIdStr },
        ],
      });

      if (!order) {
        return res.status(404).json({ message: "Order not found" });
      }

      // Enrich order with computed fields
      const { name, email } = extractCustomer(order);
      const items = Array.isArray(order.items) ? order.items : [];
      const itemCount = items.reduce(
        (sum, item) => sum + (item.quantity || 1),
        0
      );
      const totalRaw = order.totalAmount ?? order.grandTotal ?? order.subtotal ?? 0;
      const totalAmount =
        typeof totalRaw === "number" ? totalRaw : Number(totalRaw) || 0;

      const enrichedOrder = {
        ...order,
        customerName: name,
        customerEmail: email,
        itemCount,
        totalAmount,
        totals: order.totals || {
          subtotal: order.subtotal || totalAmount,
          shipping: order.shippingFee || order.shippingCost || 0,
          discount: order.discount || 0,
          grandTotal: totalAmount,
        },
        shippingAddress: order.shippingAddress || order.shipping || null,
        shippingMeta: order.shippingMeta || null,
        notes: order.notes || order.customerNotes || null,
      };

      res.json({ order: enrichedOrder });
    } catch (err) {
      console.error("Seller single order error:", err);
      res.status(500).json({
        message: "Error fetching order details",
        error: err.message,
      });
    }
  }
);

export default router;
