
export const isAdminMiddleware = (req, res, next) => {
  if (req.user?.role === "admin") {
    next();
  } else {
    return res.status(403).json({ message: "Admins only" });
  }
};
