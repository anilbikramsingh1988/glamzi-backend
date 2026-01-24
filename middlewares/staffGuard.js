import { isStaffMiddleware } from "./authMiddleware.js";

const ORDER_CONTROL_ROLES = new Set(["orders", "admin", "operations", "support"]);
const FINANCE_ROLES = new Set(["finance", "account", "admin"]);
const SUPER_ROLES = new Set(["super-admin", "admin"]);

function hasRole(userRole, requiredScope) {
  const role = String(userRole || "").trim().toLowerCase();
  if (SUPER_ROLES.has(role)) return true;
  if (!requiredScope) return true;
  if (role === requiredScope) return true;
  if (requiredScope === "orders") return ORDER_CONTROL_ROLES.has(role);
  if (requiredScope === "finance") return FINANCE_ROLES.has(role);
  return false;
}

export function ensureAdminRole(scope) {
  return (req, res, next) => {
    const userRole = req.user?.role;
    if (!req.user || !hasRole(userRole, scope)) {
      return res.status(403).json({ message: "Forbidden" });
    }
    return next();
  };
}

export { isStaffMiddleware };
