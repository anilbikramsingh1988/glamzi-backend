// routes/authRoutes.js
// Unified auth for customer, seller, admin/staff

import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";
import { ObjectId } from "mongodb";

import { client } from "../dbConfig.js";
import { authMiddleware, isStaffMiddleware } from "../middlewares/authMiddleware.js";

dotenv.config();

const router = express.Router();

const dbName = process.env.DB_NAME || "glamzi_ecommerce"; // ✅ unified DB name
const db = client.db(dbName);
const Users = db.collection("users");
const AdminNotifications = db.collection("admin_notifications");

const JWT_SECRET = process.env.JWT_SECRET || "mysecretkey";

// ===== Helpers =====
const normalizeEmail = (email = "") => email.trim().toLowerCase();

function signToken(user) {
  const userId = user?._id?.toString?.() || String(user?._id || user?.id || "");
  return jwt.sign(
    {
      id: userId,
      _id: userId,
      email: user.email,
      role: user.role,
    },
    JWT_SECRET,
    { expiresIn: "7d" }
  );
}

function buildAuthResponse(user, message = "Login successful") {
  const token = signToken(user);

  return {
    message,
    token,
    user: {
      id: user._id.toString(),
      name: user.storeName || user.name || "",
      email: user.email,
      role: user.role,
      status: user.status || null,
      storeName: user.storeName || null,
      phone: user.phone || null,
      branch: user.branch || null,
    },
  };
}

/* =========================================================
   CUSTOMER AUTH
   ========================================================= */

/**
 * POST /api/auth/register
 * Customer register
 */
router.post("/register", async (req, res) => {
  try {
    const { firstName, lastName, phone, email, password } = req.body;

    if (!firstName || !lastName || !phone || !email || !password) {
      return res.status(400).json({ message: "Please fill all fields" });
    }

    const lowerEmail = normalizeEmail(email);

    // No role from frontend allowed
    const existing = await Users.findOne({ email: lowerEmail });
    if (existing) {
      return res.status(400).json({ message: "User already exists" });
    }

    const hashed = await bcrypt.hash(password, 10);
    const now = new Date();

    const newUser = {
      firstName,
      lastName,
      name: `${firstName} ${lastName}`,
      phone,
      email: lowerEmail,
      password: hashed,

      role: "customer", // ✅ forced
      blocked: false,
      status: "active",

      createdAt: now,
      updatedAt: now,
    };

    const result = await Users.insertOne(newUser);

    return res.status(201).json({
      message: "Customer registered successfully",
      userId: result.insertedId,
    });
  } catch (err) {
    console.error("Customer register error:", err);
    return res
      .status(500)
      .json({ message: "Server error", error: err.message });
  }
});

/**
 * POST /api/auth/login
 * Customer login
 */
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res
        .status(400)
        .json({ message: "Please enter email and password" });
    }

    const lowerEmail = normalizeEmail(email);

    // ✅ Find by email ONLY first
    const user = await Users.findOne({ email: lowerEmail });

    if (!user) {
      return res.status(400).json({ message: "User not found" });
    }

    // 🔒 Role-based routing
    if (user.role === "seller") {
      return res.status(400).json({
        message:
          "This email belongs to a seller account. Please use the seller login page.",
      });
    }

    const adminRoles = [
      "admin",
      "super-admin",
      "account",
      "marketing",
      "support",
    ];

    if (adminRoles.includes(user.role)) {
      return res.status(400).json({
        message:
          "This email belongs to an admin/staff account. Please use the admin login page.",
      });
    }

    // ✅ Only allow customer-style roles here
    if (!["customer", "user"].includes(user.role)) {
      return res.status(400).json({
        message: "This account type cannot log in from customer portal.",
      });
    }

    if (user.blocked) {
      return res.status(403).json({
        message: "Your account is blocked. Please contact support.",
      });
    }

    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      return res.status(400).json({ message: "Invalid password" });
    }

    return res.json(buildAuthResponse(user, "Customer login successful"));
  } catch (err) {
    console.error("Customer login error:", err);
    return res
      .status(500)
      .json({ message: "Server error", error: err.message });
  }
});

/* =========================================================
   SELLER AUTH
   ========================================================= */

/**
 * POST /api/auth/seller/register
 * Seller register
 */
router.post("/seller/register", async (req, res) => {
  try {
    const {
      firstName,
      lastName,
      phone,
      email,
      password,
      shopName,
      storeName,
      description,
      seoTitle,
      seoDescription,
    } = req.body;

    const finalStoreName = storeName || shopName;

    if (
      !firstName ||
      !lastName ||
      !phone ||
      !email ||
      !password ||
      !finalStoreName
    ) {
      return res.status(400).json({ message: "Please fill all fields" });
    }

    const lowerEmail = normalizeEmail(email);

    const existing = await Users.findOne({ email: lowerEmail });
    if (existing) {
      return res
        .status(400)
        .json({ message: "Account with this email already exists" });
    }

    const hashed = await bcrypt.hash(password, 10);
    const now = new Date();

    const cleanDescription = description ? String(description).trim() : "";
    const cleanSeoTitle = seoTitle ? String(seoTitle).trim() : "";
    const cleanSeoDescription = seoDescription ? String(seoDescription).trim() : "";

    const newSeller = {
      ownerFirstName: firstName,
      ownerLastName: lastName,
      name: `${firstName} ${lastName}`,
      storeName: finalStoreName,
      shopName: finalStoreName,
      ...(cleanDescription ? { description: cleanDescription, storeDescription: cleanDescription } : {}),
      ...(cleanSeoTitle ? { seoTitle: cleanSeoTitle } : {}),
      ...(cleanSeoDescription ? { seoDescription: cleanSeoDescription } : {}),
      phone,
      email: lowerEmail,
      password: hashed,

      role: "seller", // ✅ forced
      blocked: false,
      status: "pending",

      createdAt: now,
      updatedAt: now,
    };

    const result = await Users.insertOne(newSeller);

    try {
      const storeLabel = finalStoreName || "New Seller";
      await AdminNotifications.insertOne({
        type: "seller_pending",
        title: "New seller request",
        body: `${storeLabel} requested to join Glamzi.`,
        sellerId: result.insertedId,
        read: false,
        createdAt: now,
      });
    } catch (notifyErr) {
      console.error("Admin notification insert failed:", notifyErr);
    }

    return res.json({
      message: "Seller registered successfully",
      data: { insertedId: result.insertedId },
    });
  } catch (err) {
    console.error("Seller register error:", err);
    return res
      .status(500)
      .json({ message: "Server error", error: err.message });
  }
});

/**
 * POST /api/auth/seller/login
 * Seller login
 */
router.post("/seller/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const lowerEmail = normalizeEmail(email);

    const user = await Users.findOne({ email: lowerEmail, role: "seller" });
    if (!user) {
      return res.status(400).json({ message: "Seller not found" });
    }

    if (user.blocked) {
      return res.status(403).json({
        message: "Your seller account is blocked. Please contact support.",
      });
    }

    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      return res.status(400).json({ message: "Invalid password" });
    }

    const token = signToken(user);

    return res.json({
      message: "Seller login successful",
      token,
      user: {
        id: user._id.toString(),
        name: user.storeName || user.name,
        storeName: user.storeName || null,
        ownerFirstName: user.ownerFirstName || null,
        ownerLastName: user.ownerLastName || null,
        email: user.email,
        role: user.role,
        status: user.status || null,
      },
    });
  } catch (err) {
    console.error("Seller login error:", err);
    return res
      .status(500)
      .json({ message: "Server error", error: err.message });
  }
});

/* =========================================================
   ADMIN / STAFF AUTH
   ========================================================= */

/**
 * POST /api/auth/admin/register
 * Create staff user (admin/account/marketing/support)
 * - Must be logged in as staff (admin/super-admin/account/marketing/support)
 * - Only super-admin can create `admin` role (enforced below)
 */
router.post("/admin/register", authMiddleware, isStaffMiddleware, async (req, res) => {
  try {
    const currentUser = req.user; // from token
    const { name, email, password, role, branch } = req.body;

    if (!name || !email || !password || !role) {
      return res.status(400).json({ message: "Please fill all fields." });
    }

    const allowedRoles = ["admin", "account", "marketing", "support"];
    if (!allowedRoles.includes(role)) {
      return res.status(400).json({ message: "Invalid role." });
    }

    // 🔐 Only super-admin can create admin accounts
    if (role === "admin" && currentUser.role !== "super-admin") {
      return res.status(403).json({
        message: "Only super-admin can create admin accounts.",
      });
    }

    const lowerEmail = normalizeEmail(email);

    const existing = await Users.findOne({ email: lowerEmail });
    if (existing) {
      return res
        .status(400)
        .json({ message: "User with this email already exists." });
    }

    const hashed = await bcrypt.hash(password, 10);
    const now = new Date();

    const newStaff = {
      name,
      email: lowerEmail,
      password: hashed,

      role, // admin / account / marketing / support
      status: "pending", // to be approved via your approval flow

      blocked: false,
      requestedRole: role,
      branch: branch || null,
      createdBy: new ObjectId(currentUser.id),
      approvedBy: null,
      approvedAt: null,

      createdAt: now,
      updatedAt: now,
    };

    const result = await Users.insertOne(newStaff);

    return res.status(201).json({
      message: "Staff user created in pending state.",
      userId: result.insertedId,
    });
  } catch (err) {
    console.error("Admin staff register error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

/**
 * POST /api/auth/admin/login
 * Admin / staff login
 * Allowed roles: admin, super-admin, account, marketing, support
 */
router.post("/admin/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const lowerEmail = normalizeEmail(email);

    const allowedRoles = [
      "admin",
      "super-admin",
      "account",
      "marketing",
      "support",
    ];

    const user = await Users.findOne({
      email: lowerEmail,
      role: { $in: allowedRoles },
    });

    if (!user) {
      return res.status(400).json({ message: "Admin/staff not found" });
    }

    if (user.blocked) {
      return res
        .status(403)
        .json({ message: "This admin/staff account is blocked." });
    }

    if (user.status === "pending") {
      return res
        .status(403)
        .json({ message: "This account is pending approval." });
    }

    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      return res.status(400).json({ message: "Invalid password" });
    }

    // ✅ Use shared helper so frontend always gets consistent shape
    return res.json(buildAuthResponse(user, "Admin login successful"));
  } catch (err) {
    console.error("Admin login error:", err);
    return res
      .status(500)
      .json({ message: "Server error", error: err.message });
  }
});

/**
 * GET /api/auth/admin/me
 * Current admin/staff info
 */
router.get("/admin/me", authMiddleware, isStaffMiddleware, async (req, res) => {
  try {
    const user = await Users.findOne(
      { _id: new ObjectId(req.user.id) },
      { projection: { password: 0 } }
    );

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    return res.json(user);
  } catch (err) {
    console.error("Admin me error:", err);
    return res
      .status(500)
      .json({ message: "Server error", error: err.message });
  }
});

/* =========================================================
   GENERIC AUTH ME (ANY LOGGED-IN USER)
   ========================================================= */

/**
 * GET /api/auth/me
 */
router.get("/me", authMiddleware, async (req, res) => {
  try {
    const user = await Users.findOne(
      { _id: new ObjectId(req.user.id) },
      { projection: { password: 0 } }
    );
    if (!user) return res.status(404).json({ message: "User not found" });
    return res.json(user);
  } catch (err) {
    console.error("Auth me error:", err);
    return res
      .status(500)
      .json({ message: "Server error", error: err.message });
  }
});

export default router;
