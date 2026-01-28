// index.js (ESM)
//
// ✅ Fixes route collisions by strict admin mounting
// ✅ adminOrdersRoutes mounted ONLY at /api/admin/orders
// ✅ admin invoices/settlements/commission mounted on their own prefixes (best practice)
// ✅ CORS hardened for local ports + env URLs
//
// ✅ RETURNS (ALIGNED):
// - Customer returns stay at:        /api/returns        (returnsRoutes)
// - Seller returns live ONLY at:     /api/seller/returns (sellerReturnsRoutes)
//   ✅ Prevents 403 collisions where seller-only guards block customer calls
//   ✅ Removes seller routing from /api/returns/* namespace
//
// ✅ DISCOUNTS (ALIGNED):
// - Admin discounts engine + seller discount moderation mounted at: /api/admin/discounts
//
// NOTE:
// - adminCouponRoutes stays at /api/admin (so /api/admin/coupons works)
// - cartCouponRoutes stays ONLY at /api/cart/coupons (avoid duplicate mounts)

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import helmet from "helmet";

import { client } from "./dbConfig.js";
import { ObjectId } from "mongodb";
import { startShippingReconciler } from "./jobs/shippingReconciler.js";
import { runReturnsSlaEscalation } from "./jobs/returnsSlaEscalation.js";
import shippingCallbackRoutesFactory from "./routes/shippingCallbackRoutes.js";

dotenv.config();

const app = express();
const dbName = process.env.DB_NAME || "glamzi_ecommerce";
const db = client.db(dbName);

const Orders = db.collection("orders");
const Invoices = db.collection("invoices");
const Users = db.collection("users");
const Discounts = db.collection("discounts");
const FlashReservations = db.collection("flashReservations");

// ========= FIX __dirname for ESM =========
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ===== ROUTE IMPORTS =====
import adminSellerRoutes from "./routes/adminSellerRoutes.js";
import authRoutes from "./routes/authRoutes.js";
import productRoutes from "./routes/productRoute.js";
import categoryRoutes from "./routes/categoryRoutes.js";
import brandRoutes from "./routes/brandRoutes.js";
import adminRoutes from "./routes/adminRoutes.js";
import sellerPublicRoutes from "./routes/sellerPublicRoutes.js";
import sellerRoutes from "./routes/sellerRoutes.js";
import sellerShippingRoutes from "./routes/sellerShippingRoutes.js";
import everestShippingRoutes from "./routes/everestShippingRoutes.js";
import cartRoutes from "./routes/cartRoutes.js";
import ordersRoutes from "./routes/ordersRoutes.js";
import accountRoutes from "./routes/accountRoutes.js";

// ✅ RETURNS (customer + seller)
import sellerReturnsRoutes from "./routes/sellerReturnsRoutes.js";
import returnsRoutes from "./routes/returnsRoutes.js";
import adminReturnsRoutes from "./routes/adminReturnsRoutes.js";

// ===== Messaging routes =====
import customerMessageRoutes from "./routes/customerMessageRoutes.js";
import sellerMessageRoutes from "./routes/sellerMessageRoutes.js";
import adminMessagingRoutes from "./routes/adminMessagingRoutes.js";
import sellerCustomerMessageRoutes from "./routes/sellerCustomerMessageRoutes.js";

// ✅ Admin seller support messaging routes (baseline requirement)
import adminSellerSupportRoutes from "./routes/adminSellerSupportRoutes.js";

// ✅ Admin product review / approval routes
import adminProductRoutes from "./routes/adminProductRoutes.js";

// ✅ Admin orders listing + details (contains "/:id" so MUST be isolated)
import adminOrdersRoutes from "./routes/adminOrdersRoutes.js";
import adminRefundsRoutes from "./routes/adminRefundsRoutes.js";

// ✅ Admin customers
import adminCustomerRoutes from "./routes/adminCustomerRoutes.js";

// ✅ Admin commission listing + payouts
import adminCommissionRoutes from "./routes/adminCommissionRoutes.js";
import adminCommissionPayoutRoutes from "./routes/adminCommissionPayoutRoutes.js";

// ✅ Admin settlement routes
import adminSettlementsRoutes from "./routes/adminSettlementsRoutes.js";
import adminFinanceRoutes from "./routes/adminFinanceRoutes.js";

// ✅ Admin invoices routes
import adminInvoicesRoutes from "./routes/adminInvoicesRoutes.js";

// ✅ Admin product configuration routes
import adminProductsConfigRoutes from "./routes/adminProductsConfigRoutes.js";

// ✅ Admin dashboard stats routes
import adminDashboardRoutes from "./routes/adminDashboardRoutes.js";

// Reviews
import reviewRoutes from "./routes/reviewRoutes.js";
import storeReviewRoutes from "./routes/storeReviewRoutes.js";

// eSewa payment routes
import paymentEsewaRoutes from "./routes/paymentEsewaRoutes.js";

// Mobile API routes
import mobileRoutes from "./routes/mobileRoutes.js";

// Wishlist routes
import wishlistRoutes from "./routes/wishlistRoutes.js";

// Push notification routes
import pushNotificationRoutes from "./routes/pushNotificationRoutes.js";
import adminNotificationRoutes from "./routes/adminNotificationRoutes.js";

// =========================
// DISCOUNTS / COUPONS
// =========================
import sellerDiscountRoutes from "./routes/sellerDiscountRoutes.js";
import adminCouponRoutes from "./routes/adminCouponRoutes.js";
import cartPricingRoutes from "./routes/cartPricingRoutes.js";
import flashRoutes from "./routes/flashRoutes.js";
import flashReservationRoutes from "./routes/flashReservationRoutes.js";

// ✅ Admin discounts engine + seller discount moderation (ONE ROUTER)
import adminDiscountRoutes from "./routes/adminDiscountRoutes.js";
import adminFlashEntriesRoutes from "./routes/adminFlashEntriesRoutes.js";
import sellerFlashRoutes from "./routes/sellerFlashRoutes.js";
// ✅ Dedicated admin flash sales router
import adminFlashSalesRoutes from "./routes/adminFlashSalesRoutes.js";

// ✅ Cart coupon routes (customer cart apply/remove)
import cartCouponRoutes from "./routes/cartCouponRoutes.js";

// =====================================================
// CORS (HARDENED)
// =====================================================
const allowedOrigins = [
  "http://localhost:5000",
  "http://localhost:5173",
  "http://localhost:5174",
  "http://localhost:5175",
  "http://localhost:19000",
  "http://localhost:19006",
  "http://localhost:19007",
  "http://localhost:19008",
  "http://localhost:19010",
  "http://localhost:8000",
  "http://localhost:3001",

  // ✅ Expo / React Native dev (web/debug)
  "http://localhost:8081",

  "http://127.0.0.1:5000",
  "http://127.0.0.1:5173",
  "http://127.0.0.1:5174",
  "http://127.0.0.1:5175",
  "http://127.0.0.1:8000",

  // ✅ (Optional) same origins via LAN IP if you open them by IP in browser
  "http://192.168.1.71:3000",
  "http://192.168.1.71:5173",
  "http://192.168.1.71:5174",
  "http://192.168.1.71:5175",
  "http://192.168.1.71:8000",
  "http://192.168.1.71:8081",

  process.env.FRONTEND_URL,
  process.env.ADMIN_URL,
  process.env.SELLER_URL,
  // Production storefront + API domains
  "https://glamzibeauty.com",
  "http://glamzibeauty.com",
  "https://api.glamzibeauty.com",
  "http://api.glamzibeauty.com",
  process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : null,
  process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}:5173` : null,
  process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}:8000` : null,
  process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}:5000` : null,
].filter(Boolean);

const corsOptions = {
  origin(origin, callback) {
    // Allow non-browser clients (mobile app, Postman, curl) with no Origin header
    if (!origin) return callback(null, true);

    // Allow glamzi/glamzibeauty custom domains
    if (
      origin.endsWith(".glamzibeauty.com") ||
      origin === "https://glamzi.com" ||
      origin === "http://glamzi.com"
    ) {
      return callback(null, true);
    }

    if (allowedOrigins.includes(origin)) return callback(null, true);

    // Allow Expo cloud hosts
    if (origin && (origin.includes("exp.direct") || origin.includes("expo.dev"))) {
      return callback(null, true);
    }

    console.warn("❌ CORS blocked request from origin:", origin);
    return callback(new Error("Not allowed by CORS"));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "Cache-Control"],
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

// =====================================================
// Middleware
// =====================================================
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
  })
);

app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true, limit: "20mb" }));

// Static files
app.use("/uploads", express.static(path.join(process.cwd(), "uploads")));

// =====================================================
// Routes
// =====================================================

// AUTH
app.use("/api/auth", authRoutes);

// PUBLIC PRODUCTS
app.use("/api", productRoutes);

// CATEGORIES & BRANDS
app.use("/api", categoryRoutes);
app.use("/api", brandRoutes);

// REVIEWS
app.use("/api/reviews", reviewRoutes);
app.use("/api/store-reviews", storeReviewRoutes);

// =========================
// ADMIN ROUTES (STRICT)
// =========================

// finance/docs isolated by prefix
app.use("/api/admin", adminInvoicesRoutes);

// Legacy alias: /api/admin/settlements/payout-batches -> /api/admin/settlements/batches
app.use("/api/admin/settlements/payout-batches", (req, res) => {
  const suffix = req.url || ""; // includes path + query (e.g., "/:id?foo=1")
  const target = `/api/admin/settlements/batches${suffix}`;
  return res.redirect(307, target);
});

app.use("/api/admin", adminSettlementsRoutes);
app.use("/api/admin/finance", adminFinanceRoutes);
app.use("/api/admin", adminCommissionRoutes);
app.use("/api/admin", adminCommissionPayoutRoutes);

// orders MUST be isolated
app.use("/api/admin/orders", adminOrdersRoutes);
app.use("/api/admin/refunds", adminRefundsRoutes);

// other admin modules
app.use("/api/admin/returns", adminReturnsRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/admin", adminSellerRoutes);
app.use("/api/admin", adminSellerSupportRoutes);
app.use("/api/admin", adminCustomerRoutes);
app.use("/api/admin", adminProductRoutes);
app.use("/api/admin", adminProductsConfigRoutes);
app.use("/api/admin/dashboard", adminDashboardRoutes);
app.use("/api/admin", adminMessagingRoutes);

// ✅ Admin coupons (cart coupons, campaigns)
app.use("/api/admin", adminCouponRoutes);

// ✅ Cart pricing (if your cartPricingRoutes defines relative paths)
app.use("/api/cart", cartPricingRoutes);

// ✅ Admin discounts engine + seller discount moderation (ONE MOUNT)
app.use("/api/admin/discounts", adminDiscountRoutes);
// ✅ Dedicated admin flash sales surface
app.use("/api/admin/flash-sales", adminFlashSalesRoutes);
// ✅ Admin flash entry moderation (seller submissions)
app.use("/api/admin", adminFlashEntriesRoutes);
app.use("/api", flashRoutes);
app.use("/api/flash/reservations", flashReservationRoutes);

// =========================
// SELLER ROUTES
// =========================
app.use("/api", sellerRoutes);
app.use("/api/seller", sellerFlashRoutes);
app.use("/api/seller", sellerShippingRoutes);
// Prefer /api/everestx/shipping; keep legacy path for compatibility
app.use("/api/everestx/shipping", everestShippingRoutes);
app.use("/api/everest/shipping", everestShippingRoutes);

// Seller public store pages
app.use("/api/sellers", sellerPublicRoutes);

// ✅ Seller returns (ONLY here to avoid collisions with customer /api/returns/*)
app.use("/api/seller/returns", sellerReturnsRoutes);

// =========================
// CUSTOMER ROUTES
// =========================
app.use("/api", accountRoutes);
app.use("/api/cart", cartRoutes);

// ✅ Cart coupon apply / remove (ONLY once — avoid duplicate mounts)
app.use("/api/cart/coupons", cartCouponRoutes);

// ✅ Orders
app.use("/api/orders", ordersRoutes);

// ✅ Customer returns
app.use("/api/returns", returnsRoutes);

// ✅ Shipping callbacks
app.use("/api/shipping", shippingCallbackRoutesFactory({ Orders, Invoices }));

// =========================
// SELLER DISCOUNTS (seller dashboard)
// =========================
app.use("/api/seller/discounts", sellerDiscountRoutes);

// =========================
// Messaging
// =========================
app.use("/api", customerMessageRoutes);
app.use("/api", sellerMessageRoutes);
app.use("/api", sellerCustomerMessageRoutes);

// =========================
// Payments
// =========================
app.use("/api/payment", paymentEsewaRoutes);

// =========================
// Mobile API
// =========================
app.use("/api/mobile", mobileRoutes);

// =========================
// Wishlist
// =========================
app.use("/api/wishlist", wishlistRoutes);

// =========================
// Push Notifications
// =========================
app.use("/api/notifications", pushNotificationRoutes);
app.use("/api/admin/notifications", adminNotificationRoutes);

// =====================================================
// Root + Health
// =====================================================
app.get("/", (req, res) => {
  res.send("✅ API running fine");
});

app.get("/api/health", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// =====================================================
// 404 Handler
// =====================================================
app.use((req, res) => {
  res.status(404).json({
    message: "Route not found",
    path: req.originalUrl,
    method: req.method,
  });
});

// =====================================================
// Error Handler
// =====================================================
app.use((err, req, res, next) => {
  console.error("❌ Server error:", err);
  res.status(500).json({
    message: "Internal server error",
    error: err.message,
  });
});

// =====================================================
// Start Server + DB Connect
// =====================================================
const PORT = process.env.PORT || 3001;

client
  .connect()
  .then(() => {
    console.log("✅ Connected to MongoDB");
    app.listen(PORT, () => {
      console.log(`🚀 Server running on http://localhost:${PORT}`);
    });

    startShippingReconciler({ Orders, Users });

    runReturnsSlaEscalation({ limit: 200 }).catch((err) =>
      console.error("[SLA_JOB]", err)
    );

    setInterval(() => {
      runReturnsSlaEscalation({ limit: 200 }).catch((err) =>
        console.error("[SLA_JOB]", err)
      );
    }, 60 * 60 * 1000);

    // Flash lifecycle + reservation sweeper (every minute)
    const runFlashWorkers = async () => {
      const now = new Date();

      // Expire held reservations and release reservedQty
      try {
        const expired = await FlashReservations.find({
          status: "held",
          expiresAt: { $lte: now },
        }).toArray();
        if (expired.length) {
          const byDiscount = new Map();
          expired.forEach((r) => {
            const key = String(r.discountId);
            byDiscount.set(key, (byDiscount.get(key) || 0) + Number(r.qty || 0));
          });
          for (const [did, qty] of byDiscount.entries()) {
            const oid = ObjectId.isValid(did) ? new ObjectId(did) : null;
            if (oid) {
              await Discounts.updateOne(
                { _id: oid },
                { $inc: { reservedQty: -Math.abs(qty) }, $set: { updatedAt: new Date() } }
              );
            }
          }
          await FlashReservations.updateMany(
            { status: "held", expiresAt: { $lte: now } },
            { $set: { status: "expired", updatedAt: now } }
          );
        }
      } catch (err) {
        console.error("[FLASH_SWEEP] expire error", err);
      }

      // Lifecycle status updates
      try {
        await Discounts.updateMany(
          {
            saleType: "flash",
            status: { $ne: "disabled" },
            endAt: { $lt: now },
          },
          { $set: { status: "ended", updatedAt: now } }
        );

        await Discounts.updateMany(
          {
            saleType: "flash",
            status: { $ne: "disabled" },
            startAt: { $gt: now },
          },
          { $set: { status: "pending", updatedAt: now } }
        );

        await Discounts.updateMany(
          {
            saleType: "flash",
            status: { $nin: ["disabled", "sold_out", "ended"] },
            "limits.totalQty": { $exists: true, $gt: 0 },
            $expr: { $gte: ["$soldQty", "$limits.totalQty"] },
          },
          { $set: { status: "sold_out", updatedAt: now } }
        );

        await Discounts.updateMany(
          {
            saleType: "flash",
            status: { $in: ["pending", "draft"] },
            startAt: { $lte: now },
            $or: [{ endAt: { $exists: false } }, { endAt: { $gte: now } }],
          },
          { $set: { status: "active", updatedAt: now } }
        );
      } catch (err) {
        console.error("[FLASH_LIFECYCLE] error", err);
      }
    };

    setInterval(runFlashWorkers, 60 * 1000);
  })
  .catch((err) => {
    console.error("❌ MongoDB connection error:", err);
    process.exit(1);
  });
