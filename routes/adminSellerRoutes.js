// routes/adminSellerRoutes.js
// Admin Sellers module (List + Bulk Lookup + Detail + Status/Verify/Notes)
// Mount at: app.use("/api/admin", adminSellerRoutes)

import express from "express";
import dotenv from "dotenv";
import { ObjectId } from "mongodb";

import { client } from "../dbConfig.js";
import {
  authMiddleware,
  isActiveMiddleware,
  isSuperAdminMiddleware,
} from "../middlewares/authMiddleware.js";

dotenv.config();

const router = express.Router();

/* ===============================
   DB SETUP
=============================== */
const dbName = process.env.DB_NAME || "glamzi_ecommerce";
const db = client.db(dbName);

const Users = db.collection("users");

// Optional stats collections (safe even if empty)
const Products = db.collection("products");
const Orders = db.collection("orders");

/* ===============================
   ACCESS GUARD
=============================== */
const isAdminOrSuperAdmin = (req, res, next) => {
  const role = String(req.user?.role || "").toLowerCase();
  if (role === "admin" || role === "super-admin") return next();
  return res.status(403).json({ message: "Admin access only" });
};

/* ===============================
   HELPERS
=============================== */
function toObjectId(id) {
  try {
    const s = String(id || "").trim();
    if (!ObjectId.isValid(s)) return null;
    return new ObjectId(s);
  } catch {
    return null;
  }
}

function safeProjection() {
  return {
    password: 0,
    resetToken: 0,
    resetTokenExpiry: 0,
  };
}

function escapeRegex(input = "") {
  return String(input || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function safeInt(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

/* ------------------------------------------------------------------
   GET /api/admin/sellers
   ✅ LIST sellers (paged) OR ✅ BULK LOOKUP by ids

   1) Bulk lookup mode (for Discount moderation UI):
      /api/admin/sellers?ids=id1,id2,id3

      Response: { success:true, items:[...] }

   2) Normal list mode:
      /api/admin/sellers?page=1&limit=20&status=all&search=

      Response: { sellers,total,page,limit,totalPages }
------------------------------------------------------------------- */
router.get(
  "/sellers",
  authMiddleware,
  isActiveMiddleware,
  isAdminOrSuperAdmin,
  async (req, res) => {
    try {
      // =========================
      // BULK LOOKUP MODE (ids=...)
      // =========================
      const idsRaw = String(req.query.ids || "").trim();
      if (idsRaw) {
        const ids = idsRaw
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);

        if (!ids.length) {
          return res.json({ success: true, items: [] });
        }

        const objectIds = ids
          .filter((id) => ObjectId.isValid(id))
          .map((id) => new ObjectId(id));

        // Supports both:
        // - Users._id lookup
        // - Users.sellerId string lookup (backward compatible)
        const match = {
          role: "seller",
          $or: [
            ...(objectIds.length ? [{ _id: { $in: objectIds } }] : []),
            { sellerId: { $in: ids } },
          ],
        };

        const items = await Users.find(match, {
          projection: {
            ...safeProjection(),

            // identity
            _id: 1,
            sellerId: 1,

            // names
            storeName: 1,
            shopName: 1,
            businessName: 1,
            name: 1,
            fullName: 1,
            ownerFirstName: 1,
            ownerLastName: 1,

            // ✅ LOGOS (important for UI)
            storeLogo: 1,
            logo: 1,
            avatar: 1,

            // contact
            email: 1,
            phone: 1,
            mobile: 1,

            // status
            status: 1,
            blocked: 1,
            verified: 1,
          },
        }).toArray();

        return res.json({ success: true, items });
      }

      // =========================
      // NORMAL LIST MODE
      // =========================
      const pageNum = Math.max(1, safeInt(req.query.page, 1));
      const limitNum = Math.min(100, Math.max(1, safeInt(req.query.limit, 20)));
      const skip = (pageNum - 1) * limitNum;

      const status = String(req.query.status || "all").toLowerCase();
      const search = String(req.query.search || "").trim();

      const and = [{ role: "seller" }];

      // Search filter
      if (search) {
        const rx = new RegExp(escapeRegex(search), "i");
        and.push({
          $or: [
            { storeName: rx },
            { shopName: rx },
            { businessName: rx },
            { ownerFirstName: rx },
            { ownerLastName: rx },
            { name: rx },
            { fullName: rx },
            { email: rx },
            { phone: rx },
            { mobile: rx },
          ],
        });
      }

      const sellerMatch = and.length > 1 ? { $and: and } : and[0];

      const unionPipeline = [
        { $match: sellerMatch },
        {
          $project: {
            ...safeProjection(),
            _id: 1,
            sellerId: 1,
            storeName: 1,
            shopName: 1,
            businessName: 1,
            name: 1,
            fullName: 1,
            ownerFirstName: 1,
            ownerLastName: 1,
            email: 1,
            phone: 1,
            mobile: 1,
            status: 1,
            blocked: 1,
            verified: 1,
            createdAt: 1,
            updatedAt: 1,
          },
        },
      ];

      const pipeline = [
        ...unionPipeline,
        {
          $unionWith: {
            coll: "sellers",
            pipeline: [
              {
                $match: search
                  ? {
                      $or: [
                        { storeName: { $regex: escapeRegex(search), $options: "i" } },
                        { shopName: { $regex: escapeRegex(search), $options: "i" } },
                        { businessName: { $regex: escapeRegex(search), $options: "i" } },
                        { ownerFirstName: { $regex: escapeRegex(search), $options: "i" } },
                        { ownerLastName: { $regex: escapeRegex(search), $options: "i" } },
                        { name: { $regex: escapeRegex(search), $options: "i" } },
                        { fullName: { $regex: escapeRegex(search), $options: "i" } },
                        { email: { $regex: escapeRegex(search), $options: "i" } },
                        { phone: { $regex: escapeRegex(search), $options: "i" } },
                        { mobile: { $regex: escapeRegex(search), $options: "i" } },
                      ],
                    }
                  : {},
              },
              {
                $project: {
                  _id: 1,
                  sellerId: { $ifNull: ["$sellerId", { $toString: "$_id" }] },
                  storeName: 1,
                  shopName: 1,
                  businessName: 1,
                  name: 1,
                  fullName: 1,
                  ownerFirstName: 1,
                  ownerLastName: 1,
                  email: 1,
                  phone: 1,
                  mobile: 1,
                  status: 1,
                  blocked: 1,
                  verified: 1,
                  createdAt: 1,
                  updatedAt: 1,
                },
              },
            ],
          },
        },
        {
          $addFields: {
            statusNorm: { $ifNull: ["$status", "active"] },
            blockedNorm: { $ifNull: ["$blocked", false] },
          },
        },
        ...(status === "active"
          ? [{ $match: { statusNorm: "active", blockedNorm: { $ne: true } } }]
          : status === "pending"
          ? [{ $match: { statusNorm: "pending" } }]
          : status === "blocked" || status === "suspended"
          ? [{ $match: { $or: [{ statusNorm: "blocked" }, { blockedNorm: true }] } }]
          : []),
        {
          $facet: {
            items: [
              { $sort: { createdAt: -1, _id: -1 } },
              { $skip: skip },
              { $limit: limitNum },
              {
                $project: {
                  statusNorm: 0,
                  blockedNorm: 0,
                  password: 0,
                  resetToken: 0,
                  resetTokenExpiry: 0,
                },
              },
            ],
            meta: [{ $count: "total" }],
          },
        },
      ];

      let items = [];
      let total = 0;

      try {
        const result = await Users.aggregate(pipeline).toArray();
        items = result?.[0]?.items || [];
        total = result?.[0]?.meta?.[0]?.total || 0;
      } catch (aggErr) {
        console.error("[admin sellers] aggregate failed, falling back:", aggErr?.message || aggErr);

        const [usersSellers, sellersColl] = await Promise.all([
          Users.find(sellerMatch, { projection: safeProjection() }).toArray(),
          db.collection("sellers").find({}).toArray(),
        ]);

        const normalize = (doc) => ({
          ...doc,
          sellerId: doc?.sellerId || (doc?._id ? String(doc._id) : undefined),
          storeName: doc?.storeName || doc?.shopName || doc?.businessName || doc?.name || doc?.fullName || "",
          ownerFirstName: doc?.ownerFirstName || doc?.firstName || "",
          ownerLastName: doc?.ownerLastName || doc?.lastName || "",
          status: doc?.status || "active",
          blocked: !!doc?.blocked,
        });

        const merged = [...usersSellers, ...sellersColl].map(normalize);

        const filtered = merged.filter((s) => {
          const statusNorm = String(s.status || "active").toLowerCase();
          const blockedNorm = !!s.blocked;
          if (status === "active") return statusNorm === "active" && !blockedNorm;
          if (status === "pending") return statusNorm === "pending";
          if (status === "blocked" || status === "suspended")
            return statusNorm === "blocked" || blockedNorm;
          return true;
        });

        const searched = search
          ? filtered.filter((s) => {
              const hay = [
                s.storeName,
                s.shopName,
                s.businessName,
                s.ownerFirstName,
                s.ownerLastName,
                s.name,
                s.fullName,
                s.email,
                s.phone,
                s.mobile,
              ]
                .filter(Boolean)
                .join(" ")
                .toLowerCase();
              return hay.includes(search.toLowerCase());
            })
          : filtered;

        searched.sort((a, b) => {
          const da = new Date(a.createdAt || 0).getTime();
          const dbb = new Date(b.createdAt || 0).getTime();
          return dbb - da;
        });

        total = searched.length;
        items = searched.slice(skip, skip + limitNum);
      }

      return res.json({
        sellers: items,
        total,
        page: pageNum,
        limit: limitNum,
        totalPages: Math.ceil(total / limitNum) || 1,
      });
    } catch (err) {
      console.error("❌ Admin sellers list error:", err);
      return res.status(500).json({ message: "Failed to load sellers" });
    }
  }
);

/* ------------------------------------------------------------------
   GET /api/admin/sellers/:id
   Seller details + optional stats
------------------------------------------------------------------- */
router.get(
  "/sellers/:id",
  authMiddleware,
  isActiveMiddleware,
  isAdminOrSuperAdmin,
  async (req, res) => {
    try {
      const sellerId = toObjectId(req.params.id);
      if (!sellerId)
        return res.status(400).json({ message: "Invalid seller ID" });

      const seller = await Users.findOne(
        { _id: sellerId, role: "seller" },
        { projection: safeProjection() }
      );

      if (!seller) return res.status(404).json({ message: "Seller not found" });

      const sellerIdStr = sellerId.toString();

      const [productsCount, ordersAgg] = await Promise.all([
        Products.countDocuments({ userId: sellerIdStr }),
        Orders.aggregate([
          { $match: { "items.sellerId": sellerIdStr } },
          {
            $project: {
              sellerOrderTotal: {
                $sum: {
                  $map: {
                    input: {
                      $filter: {
                        input: "$items",
                        as: "it",
                        cond: { $eq: ["$$it.sellerId", sellerIdStr] },
                      },
                    },
                    as: "si",
                    in: {
                      $multiply: [
                        {
                          $ifNull: [
                            "$$si.price",
                            { $ifNull: ["$$si.unitPrice", 0] },
                          ],
                        },
                        { $ifNull: ["$$si.quantity", 1] },
                      ],
                    },
                  },
                },
              },
            },
          },
          {
            $group: {
              _id: null,
              ordersCount: { $sum: 1 },
              totalSales: { $sum: "$sellerOrderTotal" },
            },
          },
        ]).toArray(),
      ]);

      const stats = {
        productsCount,
        ordersCount: ordersAgg?.[0]?.ordersCount || 0,
        totalSales: ordersAgg?.[0]?.totalSales || 0,
        commission: null,
      };

      const sellerProfile = {
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

      const shopProfile = {
        storeName: seller.storeName || seller.shopName || "",
        ownerFirstName: seller.ownerFirstName || "",
        ownerLastName: seller.ownerLastName || "",
        ownerPhone: seller.ownerPhone || seller.phone || "",
        ownerEmail: seller.ownerEmail || seller.email || "",

        description: seller.description || seller.storeDescription || "",
        seoTitle: seller.seoTitle || "",
        seoDescription: seller.seoDescription || "",

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

        panNumber: seller.panNumber || "",
        panDocumentUrl: seller.panDocumentUrl || "",
        registrationCertificateUrl: seller.registrationCertificateUrl || "",

        logoUrl: seller.logoUrl || "",

        defaultCurrency: seller.defaultCurrency || "NPR",
        defaultCountry: seller.defaultCountry || "Nepal",
        language: seller.language || "en",
        timezone: seller.timezone || "Asia/Kathmandu",

        bankName: seller.bankName || "",
        branchName: seller.branchName || "",
        accountName: seller.accountName || "",
        accountNumber: seller.accountNumber || "",
        bankChequeUrl: seller.bankChequeUrl || "",
      };

      return res.json({ seller, stats, sellerProfile, shopProfile });
    } catch (err) {
      console.error("❌ Admin fetch seller error:", err);
      return res.status(500).json({ message: "Failed to fetch seller" });
    }
  }
);

/* ------------------------------------------------------------------
   PATCH /api/admin/sellers/:id/profile
   Update store profile fields (description + SEO)
------------------------------------------------------------------- */
router.patch(
  "/sellers/:id/profile",
  authMiddleware,
  isActiveMiddleware,
  isAdminOrSuperAdmin,
  async (req, res) => {
    try {
      const sellerId = toObjectId(req.params.id);
      if (!sellerId)
        return res.status(400).json({ message: "Invalid seller ID" });

      const payload = req.body || {};
      const description = String(payload.description || "").trim();
      const seoTitle = String(payload.seoTitle || "").trim();
      const seoDescription = String(payload.seoDescription || "").trim();

      const patch = {
        ...(description ? { description, storeDescription: description } : {}),
        ...(seoTitle ? { seoTitle } : {}),
        ...(seoDescription ? { seoDescription } : {}),
        updatedAt: new Date(),
      };

      const seller = await Users.findOne({ _id: sellerId, role: "seller" });
      if (!seller) return res.status(404).json({ message: "Seller not found" });

      await Users.updateOne({ _id: sellerId }, { $set: patch });

      // Optional: if legacy "sellers" collection is used, update it too.
      const Sellers = db.collection("sellers");
      await Sellers.updateOne({ _id: sellerId }, { $set: patch });

      return res.json({ success: true });
    } catch (err) {
      console.error("❌ Admin update seller profile error:", err);
      return res.status(500).json({ message: "Failed to update seller profile" });
    }
  }
);

/* ------------------------------------------------------------------
   PATCH /api/admin/sellers/:id/status
------------------------------------------------------------------- */
router.patch(
  "/sellers/:id/status",
  authMiddleware,
  isActiveMiddleware,
  isAdminOrSuperAdmin,
  async (req, res) => {
    try {
      const actorRole = String(req.user?.role || "").toLowerCase();
      const sellerId = toObjectId(req.params.id);
      if (!sellerId)
        return res.status(400).json({ message: "Invalid seller ID" });

      let { status } = req.body || {};
      status = String(status || "").toLowerCase().trim();
      if (!status) return res.status(400).json({ message: "Status is required" });

      if (status === "suspended") status = "blocked";

      if (!["active", "pending", "blocked"].includes(status)) {
        return res.status(400).json({ message: "Invalid status" });
      }

      if (status === "blocked" && actorRole !== "super-admin") {
        return res
          .status(403)
          .json({ message: "Only super-admin can block sellers" });
      }

      const seller = await Users.findOne({ _id: sellerId, role: "seller" });
      if (!seller) return res.status(404).json({ message: "Seller not found" });

      const update = {
        status,
        blocked: status === "blocked",
        updatedAt: new Date(),
      };

      await Users.updateOne({ _id: sellerId }, { $set: update });

      return res.json({ success: true, status });
    } catch (err) {
      console.error("❌ Seller status patch error:", err);
      return res.status(500).json({ message: "Failed to update seller status" });
    }
  }
);

/* ------------------------------------------------------------------
   PATCH /api/admin/sellers/:id/verify
   Body: { verified: true/false }
------------------------------------------------------------------- */
router.patch(
  "/sellers/:id/verify",
  authMiddleware,
  isActiveMiddleware,
  isAdminOrSuperAdmin,
  async (req, res) => {
    try {
      const sellerId = toObjectId(req.params.id);
      if (!sellerId)
        return res.status(400).json({ message: "Invalid seller ID" });

      const { verified } = req.body || {};
      if (typeof verified !== "boolean") {
        return res.status(400).json({ message: "verified must be boolean" });
      }

      const seller = await Users.findOne({ _id: sellerId, role: "seller" });
      if (!seller) return res.status(404).json({ message: "Seller not found" });

      await Users.updateOne(
        { _id: sellerId },
        { $set: { verified, updatedAt: new Date() } }
      );

      return res.json({ success: true, verified });
    } catch (err) {
      console.error("❌ Seller verify patch error:", err);
      return res.status(500).json({ message: "Failed to update verification" });
    }
  }
);

/* ------------------------------------------------------------------
   POST /api/admin/sellers/:id/notes
   Body: { note: string }
   Stores notes on Users.adminNotes: [{ text, at, by }]
------------------------------------------------------------------- */
router.post(
  "/sellers/:id/notes",
  authMiddleware,
  isActiveMiddleware,
  isAdminOrSuperAdmin,
  async (req, res) => {
    try {
      const sellerId = toObjectId(req.params.id);
      if (!sellerId)
        return res.status(400).json({ message: "Invalid seller ID" });

      const note = String(req.body?.note || "").trim();
      if (!note) return res.status(400).json({ message: "Note is required" });

      const seller = await Users.findOne({ _id: sellerId, role: "seller" });
      if (!seller) return res.status(404).json({ message: "Seller not found" });

      const by =
        req.user?.id || req.user?._id || req.user?.email || req.user?.name || "admin";

      const noteObj = {
        text: note,
        at: new Date(),
        by: String(by),
      };

      await Users.updateOne(
        { _id: sellerId },
        { $push: { adminNotes: noteObj }, $set: { updatedAt: new Date() } }
      );

      return res.json({ success: true, note: noteObj });
    } catch (err) {
      console.error("❌ Seller notes error:", err);
      return res.status(500).json({ message: "Failed to add note" });
    }
  }
);

/* ------------------------------------------------------------------
   LEGACY SUPER ADMIN ROUTE (kept)
------------------------------------------------------------------- */
router.put(
  "/sellers/:id/status",
  authMiddleware,
  isActiveMiddleware,
  isSuperAdminMiddleware,
  async (req, res) => {
    try {
      const sellerId = toObjectId(req.params.id);
      if (!sellerId)
        return res.status(400).json({ message: "Invalid seller ID" });

      await Users.updateOne(
        { _id: sellerId },
        { $set: { ...req.body, updatedAt: new Date() } }
      );

      return res.json({ message: "Seller status updated successfully" });
    } catch (err) {
      console.error("❌ Legacy seller status error:", err);
      return res.status(500).json({ message: "Failed to update seller status" });
    }
  }
);

export default router;
