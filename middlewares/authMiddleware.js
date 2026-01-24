import jwt from "jsonwebtoken";
import dotenv from "dotenv";

dotenv.config();
const JWT_SECRET = process.env.JWT_SECRET || "mysecretkey";

const isDev = process.env.NODE_ENV !== "production";

/* ===============================
   AUTH (HARDENED)
=============================== */
export const authMiddleware = (req, res, next) => {
  try {
    // 1) Read auth header safely
    const authHeader =
      req.headers.authorization ||
      req.headers.Authorization || // some proxies / libs
      "";

    // 2) Also allow x-access-token as fallback (optional)
    const xToken =
      req.headers["x-access-token"] ||
      req.headers["X-Access-Token"] ||
      "";

    let token = "";

    // 3) Parse "Bearer <token>" case-insensitively
    if (typeof authHeader === "string" && authHeader.trim()) {
      const parts = authHeader.trim().split(/\s+/); // handles extra spaces
      const scheme = (parts[0] || "").toLowerCase();
      if (scheme === "bearer" && parts[1]) token = parts[1];
    }

    // 4) Fallback token header
    if (!token && typeof xToken === "string" && xToken.trim()) {
      token = xToken.trim();
    }

    if (!token) {
      if (isDev) {
        console.log("[AUTH] No token provided", {
          path: req.originalUrl,
          method: req.method,
          hasAuthHeader: Boolean(authHeader),
          authHeaderPreview: String(authHeader).slice(0, 20),
        });
      }
      return res.status(401).json({ message: "No token provided" });
    }

    // 5) Verify token
    const decoded = jwt.verify(token, JWT_SECRET);

    // Normalize common fields for downstream routes
    const normalizedUser = {
      ...decoded,
      _id: decoded._id || decoded.id || decoded.userId || decoded.sub || decoded.uid || null,
      id: decoded.id || decoded._id || decoded.userId || decoded.sub || decoded.uid || null,
    };
    req.user = normalizedUser;
    req.userId =
      normalizedUser.id ||
      normalizedUser._id ||
      normalizedUser.userId ||
      normalizedUser.sub ||
      normalizedUser.uid ||
      null;
    req.userRole = decoded.role || decoded.type || decoded.userType || null;
    req.userStatus = decoded.status || null;

    return next();
  } catch (err) {
    // More accurate messages help you debug quickly
    const isExpired = err?.name === "TokenExpiredError";
    const msg = isExpired ? "Token expired" : "Invalid token";

    if (isDev) {
      console.log("[AUTH] Token verify failed", {
        path: req.originalUrl,
        method: req.method,
        errorName: err?.name,
        errorMessage: err?.message,
      });
    }

    return res.status(401).json({ message: msg });
  }
};

/* ===============================
   ROLE GUARDS
=============================== */

// ✅ Admin OR Super Admin
export const isAdminMiddleware = (req, res, next) => {
  const role = req.user?.role;
  if (role === "admin" || role === "super-admin") return next();
  return res.status(403).json({ message: "Admin access only" });
};

// ✅ ONLY Super Admin
export const isSuperAdminMiddleware = (req, res, next) => {
  if (req.user?.role === "super-admin") return next();
  return res.status(403).json({ message: "Super Admin only" });
};

// ✅ Staff (admin + others)
export const isStaffMiddleware = (req, res, next) => {
  const allowed = ["super-admin", "admin", "account", "marketing", "support"];
  if (allowed.includes(req.user?.role)) return next();
  return res.status(403).json({ message: "Staff access only" });
};

// ✅ Seller
export const isSellerMiddleware = (req, res, next) => {
  if (req.user?.role === "seller") return next();
  return res.status(403).json({ message: "Seller access only" });
};

// ✅ Customer
export const isCustomerMiddleware = (req, res, next) => {
  if (["customer", "user"].includes(req.user?.role)) return next();
  return res.status(403).json({ message: "Customer access only" });
};

// ✅ Active account
export const isActiveMiddleware = (req, res, next) => {
  if (!req.user?.status || req.user?.status === "active") return next();
  return res.status(403).json({
    message:
      req.user.status === "pending"
        ? "Account pending approval"
        : "Account blocked",
  });
};
