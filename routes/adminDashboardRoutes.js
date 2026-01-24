// routes/adminDashboardRoutes.js
import express from "express";
import { ObjectId } from "mongodb";
import { client } from "../dbConfig.js";
import {
  authMiddleware,
  isActiveMiddleware,
  isStaffMiddleware,
} from "../middlewares/authMiddleware.js";

const router = express.Router();

const dbName = process.env.DB_NAME || "glamzi_ecommerce";
const db = client.db(dbName);

const Orders = db.collection("orders");
const Products = db.collection("products");
const Users = db.collection("users");
const Categories = db.collection("categories");
const Invoices = db.collection("invoices");

function getDateRange(period) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  
  switch (period) {
    case "today":
      return { start: today, end: now };
    case "week":
      const weekStart = new Date(today);
      weekStart.setDate(weekStart.getDate() - 7);
      return { start: weekStart, end: now };
    case "month":
      const monthStart = new Date(today);
      monthStart.setMonth(monthStart.getMonth() - 1);
      return { start: monthStart, end: now };
    case "year":
      const yearStart = new Date(today);
      yearStart.setFullYear(yearStart.getFullYear() - 1);
      return { start: yearStart, end: now };
    default:
      return { start: null, end: null };
  }
}

router.get(
  "/stats",
  authMiddleware,
  isActiveMiddleware,
  isStaffMiddleware,
  async (req, res) => {
    try {
      const { period = "month" } = req.query;
      const { start, end } = getDateRange(period);
      const dateFilter = start ? { createdAt: { $gte: start, $lte: end } } : {};

      const [
        totalOrders,
        totalProducts,
        totalSellers,
        totalCustomers,
        totalCategories,
        salesAggregation,
        orderStatusCounts,
        recentOrders,
        topProducts,
        monthlySalesData,
        dailySalesData,
        commissionData,
        pendingProducts,
      ] = await Promise.all([
        Orders.countDocuments(dateFilter),
        Products.countDocuments({ status: { $ne: "deleted" } }),
        Users.countDocuments({ role: "seller", status: "active" }),
        Users.countDocuments({ role: "customer" }),
        Categories.countDocuments({}),
        
        Orders.aggregate([
          { $match: { ...dateFilter, status: { $ne: "cancelled" } } },
          {
            $group: {
              _id: null,
              totalRevenue: {
                $sum: {
                  $ifNull: [
                    "$totals.grandTotal",
                    { $ifNull: ["$totalAmount", 0] },
                  ],
                },
              },
              avgOrderValue: {
                $avg: {
                  $ifNull: [
                    "$totals.grandTotal",
                    { $ifNull: ["$totalAmount", 0] },
                  ],
                },
              },
              totalItems: { $sum: { $ifNull: ["$totals.totalQuantity", 1] } },
            },
          },
        ]).toArray(),

        Orders.aggregate([
          { $match: dateFilter },
          { $group: { _id: "$status", count: { $sum: 1 } } },
        ]).toArray(),

        Orders.find(dateFilter)
          .sort({ createdAt: -1 })
          .limit(10)
          .project({
            _id: 1,
            orderNumber: 1,
            status: 1,
            paymentStatus: 1,
            paymentMethod: 1,
            createdAt: 1,
            totals: 1,
            totalAmount: 1,
            customerName: 1,
            "shippingAddress.fullName": 1,
          })
          .toArray(),

        Products.aggregate([
          { $match: { status: "approved" } },
          { $sort: { soldCount: -1 } },
          { $limit: 10 },
          {
            $project: {
              _id: 1,
              title: 1,
              soldCount: 1,
              price: 1,
              images: { $slice: ["$images", 1] },
            },
          },
        ]).toArray(),

        Orders.aggregate([
          {
            $match: {
              createdAt: {
                $gte: new Date(new Date().setMonth(new Date().getMonth() - 12)),
              },
              status: { $ne: "cancelled" },
            },
          },
          {
            $group: {
              _id: {
                year: { $year: "$createdAt" },
                month: { $month: "$createdAt" },
              },
              revenue: {
                $sum: {
                  $ifNull: ["$totals.grandTotal", { $ifNull: ["$totalAmount", 0] }],
                },
              },
              orders: { $sum: 1 },
            },
          },
          { $sort: { "_id.year": 1, "_id.month": 1 } },
        ]).toArray(),

        Orders.aggregate([
          {
            $match: {
              createdAt: {
                $gte: new Date(new Date().setDate(new Date().getDate() - 30)),
              },
              status: { $ne: "cancelled" },
            },
          },
          {
            $group: {
              _id: {
                year: { $year: "$createdAt" },
                month: { $month: "$createdAt" },
                day: { $dayOfMonth: "$createdAt" },
              },
              revenue: {
                $sum: {
                  $ifNull: ["$totals.grandTotal", { $ifNull: ["$totalAmount", 0] }],
                },
              },
              orders: { $sum: 1 },
            },
          },
          { $sort: { "_id.year": 1, "_id.month": 1, "_id.day": 1 } },
        ]).toArray(),

        Invoices.aggregate([
          {
            $match: dateFilter,
          },
          {
            $group: {
              _id: {
                year: { $year: "$createdAt" },
                month: { $month: "$createdAt" },
              },
              totalCommission: { $sum: { $ifNull: ["$commissionAmount", 0] } },
              invoiceCount: { $sum: 1 },
            },
          },
          { $sort: { "_id.year": 1, "_id.month": 1 } },
        ]).toArray(),

        Products.countDocuments({ status: "pending" }),
      ]);

      const sales = salesAggregation[0] || {
        totalRevenue: 0,
        avgOrderValue: 0,
        totalItems: 0,
      };

      const statusMap = {};
      orderStatusCounts.forEach((s) => {
        const key = (s._id || "unknown").toLowerCase();
        statusMap[key] = s.count;
      });

      const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

      const monthlyData = monthlySalesData.map((m) => ({
        month: monthNames[m._id.month - 1],
        year: m._id.year,
        revenue: Math.round(m.revenue),
        orders: m.orders,
      }));

      const dailyData = dailySalesData.map((d) => ({
        date: `${d._id.month}/${d._id.day}`,
        revenue: Math.round(d.revenue),
        orders: d.orders,
      }));

      const commissionMonthly = commissionData.map((c) => ({
        month: monthNames[c._id.month - 1],
        year: c._id.year,
        commission: Math.round(c.totalCommission),
        invoices: c.invoiceCount,
      }));

      const totalCommission = commissionData.reduce(
        (sum, c) => sum + (c.totalCommission || 0),
        0
      );

      res.json({
        success: true,
        period,
        overview: {
          totalOrders,
          totalRevenue: Math.round(sales.totalRevenue),
          avgOrderValue: Math.round(sales.avgOrderValue),
          totalProducts,
          totalSellers,
          totalCustomers,
          totalCategories,
          totalCommission: Math.round(totalCommission),
          pendingProducts,
        },
        orderStatus: {
          created: statusMap.created || 0,
          pending: statusMap.pending || 0,
          confirmed: statusMap.confirmed || 0,
          processing: statusMap.processing || 0,
          shipped: statusMap.shipped || 0,
          delivered: statusMap.delivered || 0,
          completed: statusMap.completed || 0,
          cancelled: statusMap.cancelled || 0,
          returned: statusMap.returned || 0,
        },
        charts: {
          monthlySales: monthlyData,
          dailySales: dailyData,
          monthlyCommission: commissionMonthly,
        },
        recentOrders: recentOrders.map((o) => ({
          _id: o._id,
          orderNumber: o.orderNumber || String(o._id).slice(-8).toUpperCase(),
          status: o.status,
          paymentStatus: o.paymentStatus,
          paymentMethod: o.paymentMethod,
          createdAt: o.createdAt,
          total: o.totals?.grandTotal || o.totalAmount || 0,
          customerName: o.customerName || o.shippingAddress?.fullName || "Guest",
        })),
        topProducts,
      });
    } catch (err) {
      console.error("❌ Dashboard stats error:", err);
      res.status(500).json({ success: false, message: "Failed to fetch dashboard stats" });
    }
  }
);

export default router;
