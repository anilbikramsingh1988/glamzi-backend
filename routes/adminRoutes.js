// routes/adminRoutes.js
import express from "express";
import dotenv from "dotenv";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { ObjectId } from "mongodb";

import { client } from "../dbConfig.js";
import {
  authMiddleware,
  isActiveMiddleware,
  isSuperAdminMiddleware,
  isStaffMiddleware,
} from "../middlewares/authMiddleware.js";

import {
  sendInviteEmail,
  sendPasswordResetEmail,
} from "../services/emailService.js";
import { logAdminAction } from "../services/auditLogService.js";

dotenv.config();

const router = express.Router();

// ====== DB SETUP ======
const dbName = process.env.DB_NAME || "glamzi_ecommerce";
const db = client.db(dbName);

const Users = db.collection("users");
// routes/adminRoutes.js (add near the top after Products)
const AdminActivityLogs = db.collection("adminActivityLogs");

const Products = db.collection("products");

// ✅ IMPORTANT: use the SAME default secret as authRoutes/authMiddleware
const JWT_SECRET = process.env.JWT_SECRET || "mysecretkey";

// ====== HELPERS ======
function generateTempPassword(length = 10) {
  const chars =
    "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%";
  let pwd = "";
  for (let i = 0; i < length; i++) {
    pwd += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return pwd;
}

/* ------------------------------------------------------------------
   SECTION 1: ADMIN AUTH (REGISTER / LOGIN / PROFILE / FORGOT PASSWORD)
   Prefix: /api/admin/auth/*
------------------------------------------------------------------- */

/**
 * Admin-only auth middleware (for /auth/profile).
 * NOTE: other admin routes use the shared authMiddleware + role guards.
 */
export const adminAuthMiddleware = (req, res, next) => {
  try {
    const authHeader = req.headers.authorization || "";
    const parts = authHeader.split(" ");

    if (parts.length !== 2 || parts[0] !== "Bearer") {
      return res.status(401).json({ message: "No token provided" });
    }

    const token = parts[1];
    const decoded = jwt.verify(token, JWT_SECRET);

    // Allow both admin and super-admin here if you want
    if (!decoded || !decoded.role || !["admin", "super-admin"].includes(decoded.role)) {
      return res.status(403).json({ message: "Forbidden: Admins only" });
    }

    req.admin = {
      id: decoded.id,
      email: decoded.email,
      role: decoded.role,
    };

    next();
  } catch (err) {
    console.error("adminAuthMiddleware error:", err);
    return res
      .status(403)
      .json({ message: "Invalid or expired token", error: err.message });
  }
};

/**
 * POST /api/admin/auth/register
 * → Register an admin/staff (still needs approval)
 */
router.post("/auth/register", async (req, res) => {
  try {
    const { firstName, lastName, email, mobile, branch, role, password } =
      req.body;

    if (!firstName || !lastName || !email || !password) {
      return res.status(400).json({ message: "Required fields missing" });
    }

    const exists = await Users.findOne({ email: email.toLowerCase() });
    if (exists) {
      return res.status(409).json({ message: "Email already registered" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    await Users.insertOne({
      firstName,
      lastName,
      fullName: `${firstName} ${lastName}`,
      email: email.toLowerCase(),
      mobile,
      branch,
      role: role?.toLowerCase() || "admin",
      status: "pending", // waiting for super-admin approval
      password: hashedPassword,
      createdAt: new Date(),
    });

    res.json({
      message: "Registration successful. Await admin approval.",
    });
  } catch (err) {
    console.error("Admin register error:", err);
    res.status(500).json({ message: "Registration failed" });
  }
});

/**
 * POST /api/admin/auth/login
 */
router.post("/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await Users.findOne({ email: email.toLowerCase() });
    if (!user) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    if (user.status !== "active") {
      return res.status(403).json({
        message:
          user.status === "pending"
            ? "Account pending approval"
            : "Account blocked",
      });
    }

    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const token = jwt.sign(
      {
        id: user._id.toString(),
        role: user.role,
        email: user.email,
      },
      JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.json({
      token,
      user: {
        id: user._id,
        firstName: user.firstName,
        lastName: user.lastName,
        fullName: user.fullName,
        email: user.email,
        role: user.role,
        status: user.status,
      },
    });
  } catch (err) {
    console.error("Admin login error:", err);
    res.status(500).json({ message: "Login failed" });
  }
});

/**
 * GET /api/admin/auth/profile
 */
router.get("/auth/profile", adminAuthMiddleware, async (req, res) => {
  try {
    const adminId = req.admin.id;

    const user = await Users.findOne({ _id: new ObjectId(adminId) });
    if (!user) {
      return res.status(404).json({ message: "Admin not found" });
    }

    res.json({
      id: user._id,
      firstName: user.firstName,
      lastName: user.lastName,
      fullName: user.fullName,
      email: user.email,
      mobile: user.mobile,
      branch: user.branch,
      role: user.role,
      status: user.status,
      createdAt: user.createdAt,
    });
  } catch (err) {
    console.error("Fetch admin profile error:", err);
    res.status(500).json({ message: "Failed to load admin profile" });
  }
});

/**
 * POST /api/admin/auth/forgot-password
 */
router.post("/auth/forgot-password", async (req, res) => {
  try {
    const { email } = req.body;

    const user = await Users.findOne({ email: email.toLowerCase() });
    if (!user) {
      return res.status(404).json({ message: "Email not registered" });
    }

    const token = crypto.randomBytes(32).toString("hex");

    await Users.updateOne(
      { _id: user._id },
      {
        $set: {
          resetToken: token,
          resetTokenExpiry: new Date(Date.now() + 1000 * 60 * 30),
        },
      }
    );

    console.log(
      `🔐 Admin reset link: https://admin.glamzi.com/reset-password/${token}`
    );

    res.json({
      message: "Password reset link sent to your email.",
    });
  } catch (err) {
    console.error("Forgot password error:", err);
    res.status(500).json({ message: "Failed to send reset link" });
  }
});

/* ------------------------------------------------------------------
   SECTION 2: STAFF APPROVAL & MANAGEMENT (SUPER-ADMIN)
------------------------------------------------------------------- */

router.get(
  "/staff/pending",
  authMiddleware,
  isActiveMiddleware,
  isSuperAdminMiddleware,
  async (req, res) => {
    try {
      const pending = await Users.find({ status: "pending" }).toArray();

      const admins = [];
      const others = [];

      pending.forEach((u) => {
        const role = (u.role || "").toLowerCase();
        if (role === "admin" || role === "super-admin") {
          admins.push(u);
        } else {
          others.push(u);
        }
      });

      res.json({ admins, others });
    } catch (err) {
      console.error("Error fetching pending users:", err);
      res.status(500).json({ message: "Failed to load pending users" });
    }
  }
);

router.post(
  "/staff",
  authMiddleware,
  isActiveMiddleware,
  isSuperAdminMiddleware,
  async (req, res) => {
    try {
      const { firstName, lastName, email, role, password } = req.body;

      if (!firstName || !lastName || !email || !role) {
        return res.status(400).json({ message: "Required fields missing" });
      }

      const existing = await Users.findOne({ email: email.toLowerCase() });
      if (existing) {
        return res.status(409).json({ message: "Email already exists" });
      }

      const plainPassword =
        password && password.trim().length
          ? password
          : generateTempPassword(10);

      const hashedPassword = await bcrypt.hash(plainPassword, 10);

      const insertResult = await Users.insertOne({
        firstName,
        lastName,
        fullName: `${firstName} ${lastName}`,
        email: email.toLowerCase(),
        role,
        status: "active",
        password: hashedPassword,
        mustChangePassword: true,
        createdAt: new Date(),
      });

      await logAdminAction({
        action: "USER_CREATED",
        actor: req.user,
        targetUserId: insertResult.insertedId,
        details: { firstName, lastName, email, role },
      });

      await sendInviteEmail({
        to: email.toLowerCase(),
        name: `${firstName} ${lastName}`,
        tempPassword: plainPassword,
      });

      res.json({ message: "User created and invite sent successfully" });
    } catch (err) {
      console.error("Error creating user:", err);
      res.status(500).json({ message: "Failed to create user" });
    }
  }
);

router.get(
  "/staff",
  authMiddleware,
  isActiveMiddleware,
  isSuperAdminMiddleware,
  async (req, res) => {
    try {
      const { page = 1, limit = 50, role, status, search } = req.query;

      const pageNum = Number(page) || 1;
      const limitNum = Number(limit) || 50;
      const skip = (pageNum - 1) * limitNum;

      const filter = {};
      const staffRoles = ["super-admin", "admin", "account", "marketing"];

      if (role) {
        filter.role = role.toLowerCase();
      } else {
        filter.role = { $in: staffRoles };
      }

      if (status) {
        filter.status = status;
      }

      if (search) {
        const s = String(search);
        filter.$or = [
          { firstName: { $regex: s, $options: "i" } },
          { lastName: { $regex: s, $options: "i" } },
          { fullName: { $regex: s, $options: "i" } },
          { email: { $regex: s, $options: "i" } },
          { mobile: { $regex: s, $options: "i" } },
        ];
      }

      const projection = {
        password: 0,
        resetToken: 0,
        resetTokenExpiry: 0,
      };

      const [data, total] = await Promise.all([
        Users.find(filter, { projection })
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limitNum)
          .toArray(),
        Users.countDocuments(filter),
      ]);

      res.json({
        data,
        total,
        page: pageNum,
        limit: limitNum,
        totalPages: Math.ceil(total / limitNum),
      });
    } catch (err) {
      console.error("Error fetching staff:", err);
      res.status(500).json({ message: "Failed to load staff" });
    }
  }
);

router.put(
  "/staff/:id",
  authMiddleware,
  isActiveMiddleware,
  isSuperAdminMiddleware,
  async (req, res) => {
    try {
      const { id } = req.params;
      const { role, status } = req.body;

      if (!ObjectId.isValid(id)) {
        return res.status(400).json({ message: "Invalid user ID" });
      }

      const update = {};
      const allowedStatuses = ["active", "blocked", "pending"];
      const allowedRoles = ["super-admin", "admin", "account", "marketing"];

      if (status) {
        if (!allowedStatuses.includes(status)) {
          return res.status(400).json({ message: "Invalid status value" });
        }
        update.status = status;
      }

      if (role) {
        const normalizedRole = role.toLowerCase();
        if (!allowedRoles.includes(normalizedRole)) {
          return res.status(400).json({ message: "Invalid role value" });
        }
        update.role = normalizedRole;
      }

      if (Object.keys(update).length === 0) {
        return res.status(400).json({
          message: "Nothing to update (provide role and/or status)",
        });
      }

      const _id = new ObjectId(id);

      const user = await Users.findOne({ _id });
      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }

      if (
        user._id.toString() === req.user.id &&
        update.status &&
        update.status !== "active"
      ) {
        return res.status(400).json({
          message: "You cannot change your own status to non-active",
        });
      }

      if (
        user._id.toString() === req.user.id &&
        update.role &&
        update.role !== "super-admin"
      ) {
        return res.status(400).json({
          message: "You cannot change your own role from super-admin",
        });
      }

      await Users.updateOne(
        { _id },
        {
          $set: {
            ...update,
            updatedAt: new Date(),
          },
        }
      );

      res.json({ message: "User updated successfully" });
    } catch (err) {
      console.error("Error updating user:", err);
      res.status(500).json({ message: "Failed to update user" });
    }
  }
);

router.post(
  "/staff/:id/reset-password",
  authMiddleware,
  isActiveMiddleware,
  isSuperAdminMiddleware,
  async (req, res) => {
    try {
      const { id } = req.params;

      if (!ObjectId.isValid(id)) {
        return res.status(400).json({ message: "Invalid user id" });
      }

      const user = await Users.findOne({ _id: new ObjectId(id) });
      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }

      const tempPassword = generateTempPassword(10);
      const hashedPassword = await bcrypt.hash(tempPassword, 10);

      await Users.updateOne(
        { _id: user._id },
        {
          $set: {
            password: hashedPassword,
            mustChangePassword: true,
            updatedAt: new Date(),
          },
        }
      );

      await logAdminAction({
        action: "USER_PASSWORD_RESET",
        actor: req.user,
        targetUserId: id,
        details: { email: user.email },
      });

      await sendPasswordResetEmail({
        to: user.email,
        name: user.fullName || user.firstName,
        tempPassword,
      });

      res.json({ message: "Password reset and email sent" });
    } catch (err) {
      console.error("Error resetting password:", err);
      res.status(500).json({ message: "Failed to reset password" });
    }
  }
);

/* ------------------------------------------------------------------
   SECTION 3: BASIC ADMIN DASHBOARD USERS/PRODUCTS
------------------------------------------------------------------- */

router.get(
  "/users",
  authMiddleware,
  isStaffMiddleware,
  async (req, res) => {
    const users = await Users.find(
      {},
      { projection: { password: 0, resetToken: 0 } }
    )
      .sort({ createdAt: -1 })
      .toArray();
    res.json(users);
  }
);

router.put(
  "/user/:id/block",
  authMiddleware,
  isStaffMiddleware,
  async (req, res) => {
    const { block } = req.body;
    const id = req.params.id;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid user id" });
    }

    const r = await Users.updateOne(
      { _id: new ObjectId(id) },
      { $set: { blocked: !!block } }
    );
    if (!r.matchedCount) {
      return res.status(404).json({ message: "User not found" });
    }

    await Users.updateOne(
      { _id: new ObjectId(id) },
      {
        $push: {
          notifications: {
            text: block
              ? "Your account has been blocked"
              : "Your account has been unblocked",
            date: new Date(),
          },
        },
      }
    );

    res.json({ message: `User ${block ? "blocked" : "unblocked"}` });
  }
);

router.get(
  "/products",
  authMiddleware,
  isStaffMiddleware,
  async (req, res) => {
    const products = await Products.find()
      .sort({ createdAt: -1 })
      .toArray();
    res.json(products);
  }
);

router.put(
  "/product/:id/block",
  authMiddleware,
  isStaffMiddleware,
  async (req, res) => {
    const { block } = req.body;
    const id = req.params.id;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid product id" });
    }

    const r = await Products.updateOne(
      { _id: new ObjectId(id) },
      { $set: { blocked: !!block } }
    );
    if (!r.matchedCount) {
      return res.status(404).json({ message: "Product not found" });
    }
    res.json({ message: `Product ${block ? "blocked" : "unblocked"}` });
  }
);

/* ------------------------------------------------------------------
   SECTION 4: ADMIN CUSTOMERS (LIST + DETAIL)
------------------------------------------------------------------- */

router.get(
  "/customers",
  authMiddleware,
  isStaffMiddleware,
  async (req, res) => {
    try {
      const {
        search = "",
        page = 1,
        limit = 20,
      } = req.query;

      const pageNum = Number(page) || 1;
      const limitNum = Number(limit) || 20;
      const skip = (pageNum - 1) * limitNum;

      const filter = {
        role: "customer",
      };

      if (search && search.trim()) {
        const regex = new RegExp(search.trim(), "i");
        filter.$or = [
          { name: regex },
          { fullName: regex },
          { firstName: regex },
          { lastName: regex },
          { email: regex },
          { phone: regex },
        ];
      }

      const projection = {
        password: 0,
        resetToken: 0,
        resetTokenExpiry: 0,
      };

      const [customers, total] = await Promise.all([
        Users.find(filter)
          .project(projection)
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limitNum)
          .toArray(),
        Users.countDocuments(filter),
      ]);

      res.json({
        customers,
        total,
        page: pageNum,
        limit: limitNum,
        totalPages: Math.ceil(total / limitNum),
      });
    } catch (err) {
      console.error("❌ Error fetching admin customers:", err);
      res.status(500).json({ message: "Failed to fetch customers" });
    }
  }
);

router.get(
  "/customers/:id",
  authMiddleware,
  isStaffMiddleware,
  async (req, res) => {
    try {
      const { id } = req.params;

      if (!ObjectId.isValid(id)) {
        return res.status(400).json({ message: "Invalid customer ID" });
      }

      const projection = {
        password: 0,
        resetToken: 0,
        resetTokenExpiry: 0,
      };

      const customer = await Users.findOne(
        { _id: new ObjectId(id) },
        { projection }
      );

      if (!customer) {
        return res.status(404).json({ message: "Customer not found" });
      }

      res.json(customer);
    } catch (err) {
      console.error("❌ Error fetching customer details:", err);
      res.status(500).json({ message: "Failed to fetch customer details" });
    }
  }
);
/* ------------------------------------------------------------------
   SECTION 5: ADMIN ACTIVITY LOGS
   → View recent admin actions (last 100)
------------------------------------------------------------------- */

router.get(
  "/logs",
  authMiddleware,
  isActiveMiddleware,
  isSuperAdminMiddleware, // or isStaffMiddleware if you want all staff to see logs
  async (req, res) => {
    try {
      const logs = await AdminActivityLogs.find({})
        .sort({ createdAt: -1 })
        .limit(100)
        .toArray();

      res.json({ logs });
    } catch (err) {
      console.error("Error fetching admin activity logs:", err);
      res.status(500).json({ message: "Failed to load activity logs" });
    }
  }
);

export default router;
