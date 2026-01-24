export function ensureFinanceRole(req, res, next) {
  const u = req.user || {};
  const staffRoles = Array.isArray(u.staffRoles) ? u.staffRoles : [];
  const isAdminLike = ["super-admin", "admin", "account"].includes(String(u.role || ""));
  const hasFinanceRole = staffRoles.includes("finance") || staffRoles.includes("Finance");
  if (isAdminLike || hasFinanceRole) return next();
  return res.status(403).json({ message: "Forbidden: finance role required" });
}
