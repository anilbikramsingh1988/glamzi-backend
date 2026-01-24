// routes/mobileRoutes.js

import express from "express";
import { ObjectId } from "mongodb";
import { client } from "../dbConfig.js";
import {
  authMiddleware,
  isActiveMiddleware,
} from "../middlewares/authMiddleware.js";

const router = express.Router();

const dbName = process.env.DB_NAME || "glamzi_ecommerce";
const db = client.db(dbName);

const Products = db.collection("products");
const Categories = db.collection("categories");
const Orders = db.collection("orders");
const Users = db.collection("users"); // ✅ needed for seller lookup

/* ===============================
   HOME FEED (PUBLIC)
=============================== */
router.get("/home-feed", async (req, res) => {
  try {
    const [featuredProducts, categories, newArrivals, topSelling] =
      await Promise.all([
        // Featured products
        Products.find({ status: "approved", featured: true })
          .limit(10)
          .project({
            title: 1,
            price: 1,
            discountedPrice: 1,
            images: 1,
            soldCount: 1,
          })
          .toArray(),

        // Top categories
        Categories.find({ status: "active" })
          .limit(10)
          .project({ name: 1, image: 1, productCount: 1 })
          .toArray(),

        // New arrivals
        Products.find({ status: "approved" })
          .sort({ createdAt: -1 })
          .limit(10)
          .project({
            title: 1,
            price: 1,
            discountedPrice: 1,
            images: 1,
          })
          .toArray(),

        // Top selling products
        Products.find({ status: "approved" })
          .sort({ soldCount: -1 })
          .limit(10)
          .project({
            title: 1,
            price: 1,
            discountedPrice: 1,
            images: 1,
            soldCount: 1,
          })
          .toArray(),
      ]);

    res.json({
      success: true,
      data: {
        featuredProducts,
        categories,
        newArrivals,
        topSelling,
      },
    });
  } catch (error) {
    console.error("Home feed error:", error);
    res
      .status(500)
      .json({ success: false, message: "Failed to load home feed" });
  }
});

/* ===============================
   PROFILE SUMMARY (AUTH)
=============================== */
router.get(
  "/profile-summary",
  authMiddleware,
  isActiveMiddleware,
  async (req, res) => {
    try {
      const userIdRaw = req.userId;
      const userIdStr = String(userIdRaw || "").trim();
      const role = req.userRole;

      const summary = {
        user: {
          name: req.userName || "User",
          email: req.userEmail || "",
          role,
        },
      };

      if (role === "customer") {
        const [orderCount, cartCount] = await Promise.all([
          Orders.countDocuments({ userId: userIdStr }),
          db
            .collection("carts")
            .findOne({ userId: userIdStr })
            .then((cart) => cart?.items?.length || 0),
        ]);

        summary.orders = orderCount;
        summary.cartItems = cartCount;
      } else if (role === "seller") {
        // ✅ Canonical sellerId = userIdStr, with legacy ObjectId fallback (if any old data)
        const sellerIdObj = ObjectId.isValid(userIdStr)
          ? new ObjectId(userIdStr)
          : null;

        const productOwnerMatch = sellerIdObj
          ? { $or: [{ userId: userIdStr }, { userId: sellerIdObj }] }
          : { userId: userIdStr };

        const sellerOrderMatch = sellerIdObj
          ? {
              $or: [
                { "items.sellerId": userIdStr },
                { "items.sellerId": sellerIdObj },
                { sellerId: userIdStr }, // legacy fallbacks
                { sellerId: sellerIdObj },
              ],
            }
          : {
              $or: [
                { "items.sellerId": userIdStr },
                { sellerId: userIdStr },
              ],
            };

        const [productCount, orderCount, pendingOrders] = await Promise.all([
          Products.countDocuments({
            status: { $ne: "deleted" },
            ...productOwnerMatch,
          }),
          Orders.countDocuments(sellerOrderMatch),
          Orders.countDocuments({
            status: "pending",
            ...sellerOrderMatch,
          }),
        ]);

        summary.products = productCount;
        summary.orders = orderCount;
        summary.pendingOrders = pendingOrders;
      }

      res.json({ success: true, data: summary });
    } catch (error) {
      console.error("Profile summary error:", error);
      res
        .status(500)
        .json({ success: false, message: "Failed to load profile" });
    }
  }
);

/* ===============================
   SELLER DASHBOARD (AUTH + SELLER)
=============================== */
router.get(
  "/seller/dashboard",
  authMiddleware,
  isActiveMiddleware,
  async (req, res) => {
    try {
      const role = String(req.userRole || "").toLowerCase();
      if (role !== "seller") {
        return res.status(403).json({
          success: false,
          message: "Seller dashboard is only available for sellers",
        });
      }

      const sellerIdRaw = req.userId;
      const sellerIdStr = String(sellerIdRaw || "").trim();
      const sellerIdObj = ObjectId.isValid(sellerIdStr)
        ? new ObjectId(sellerIdStr)
        : null;

      // ✅ Canonical match: items.sellerId = sellerIdStr, with legacy fallbacks
      const sellerIdMatch = sellerIdObj
        ? [
            { "items.sellerId": sellerIdStr },
            { "items.sellerId": sellerIdObj },
            { sellerId: sellerIdStr },
            { sellerId: sellerIdObj },
          ]
        : [{ "items.sellerId": sellerIdStr }, { sellerId: sellerIdStr }];

      // ✅ Fetch real seller document (store name, logo, rating, status, etc.)
      const seller = await Users.findOne(
        sellerIdObj ? { _id: sellerIdObj } : { _id: sellerIdStr },
        { projection: { password: 0 } }
      );

      const now = new Date();
      const thirtyDaysAgo = new Date(now);
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

      const sevenDaysAgo = new Date(now);
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

      const todayStart = new Date(now);
      todayStart.setHours(0, 0, 0, 0);

      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

      const [
        totalProducts,
        pendingProducts,
        totalOrders,
        pendingOrders,
        processingOrders,
        shippedOrders,
        deliveredOrders,
        cancelledOrders,
        recentOrdersRaw,
        salesData,
        weeklySalesData,
        salesWindowAgg,
        topProductsAgg,
        monthlySalesAgg,
        dailySalesAgg,
        returnsAgg,
        lowStockCount,
        todayAgg,
        weekAgg,
        monthAgg,
      ] = await Promise.all([
        // Total products (non-deleted)
        Products.countDocuments({
          status: { $ne: "deleted" },
          userId: sellerIdStr,
        }),

        // Pending products
        Products.countDocuments({
          status: "pending",
          userId: sellerIdStr,
        }),

        // Orders (any status) containing this seller
        Orders.countDocuments({ $or: sellerIdMatch }),

        Orders.countDocuments({
          status: "pending",
          $or: sellerIdMatch,
        }),

        Orders.countDocuments({
          status: "processing",
          $or: sellerIdMatch,
        }),

        Orders.countDocuments({
          status: "shipped",
          $or: sellerIdMatch,
        }),

        Orders.countDocuments({
          status: "delivered",
          $or: sellerIdMatch,
        }),

        Orders.countDocuments({
          status: "cancelled",
          $or: sellerIdMatch,
        }),

        // Recent orders
        Orders.find({ $or: sellerIdMatch })
          .sort({ createdAt: -1 })
          .limit(5)
          .project({
            orderNumber: 1,
            status: 1,
            totals: 1,
            totalAmount: 1,
            createdAt: 1,
            items: 1,
            "shippingAddress.fullName": 1,
          })
          .toArray(),

        // 30-day total sales + order count
        Orders.aggregate([
          {
            $match: {
              $or: sellerIdMatch,
              status: { $ne: "cancelled" },
              createdAt: { $gte: thirtyDaysAgo },
            },
          },
          {
            $group: {
              _id: null,
              totalSales: {
                $sum: { $ifNull: ["$totals.grandTotal", "$totalAmount"] },
              },
              orderCount: { $sum: 1 },
            },
          },
        ]).toArray(),

        // Weekly sales (last 7 days) grouped by dayOfWeek
        Orders.aggregate([
          {
            $match: {
              $or: sellerIdMatch,
              status: { $ne: "cancelled" },
              createdAt: { $gte: sevenDaysAgo },
            },
          },
          {
            $group: {
              _id: { $dayOfWeek: "$createdAt" },
              value: {
                $sum: { $ifNull: ["$totals.grandTotal", "$totalAmount"] },
              },
            },
          },
          { $sort: { _id: 1 } },
        ]).toArray(),

        // 30-day window metrics: revenue, avg order, items sold (for this seller)
        Orders.aggregate([
          {
            $match: {
              $or: sellerIdMatch,
              status: { $ne: "cancelled" },
              createdAt: { $gte: thirtyDaysAgo },
            },
          },
          { $unwind: "$items" },
          {
            $match: {
              $or: [
                { "items.sellerId": sellerIdStr },
                ...(sellerIdObj ? [{ "items.sellerId": sellerIdObj }] : []),
              ],
            },
          },
          {
            $group: {
              _id: "$_id",
              orderRevenue: {
                $first: {
                  $ifNull: ["$totals.grandTotal", "$totalAmount"],
                },
              },
              itemsQty: {
                $sum: { $ifNull: ["$items.quantity", 1] },
              },
            },
          },
          {
            $group: {
              _id: null,
              totalRevenue: { $sum: "$orderRevenue" },
              orderCount: { $sum: 1 },
              totalItems: { $sum: "$itemsQty" },
            },
          },
        ]).toArray(),

        // Top selling products (last 30 days) for this seller
        Orders.aggregate([
          {
            $match: {
              $or: sellerIdMatch,
              status: { $ne: "cancelled" },
              createdAt: { $gte: thirtyDaysAgo },
            },
          },
          { $unwind: "$items" },
          {
            $match: {
              $or: [
                { "items.sellerId": sellerIdStr },
                ...(sellerIdObj ? [{ "items.sellerId": sellerIdObj }] : []),
              ],
            },
          },
          {
            $group: {
              _id: "$items.productId",
              name: { $first: "$items.name" },
              quantity: {
                $sum: { $ifNull: ["$items.quantity", 1] },
              },
              revenue: {
                $sum: {
                  $multiply: [
                    { $ifNull: ["$items.price", 0] },
                    { $ifNull: ["$items.quantity", 1] },
                  ],
                },
              },
            },
          },
          { $sort: { quantity: -1 } },
          { $limit: 5 },
        ]).toArray(),

        // Monthly sales (last 6 months)
        Orders.aggregate([
          {
            $match: {
              $or: sellerIdMatch,
              status: { $ne: "cancelled" },
              createdAt: new Date(
                now.getFullYear(),
                now.getMonth() - 5,
                1
              ),
            },
          },
          {
            $group: {
              _id: {
                year: { $year: "$createdAt" },
                month: { $month: "$createdAt" },
              },
              revenue: {
                $sum: { $ifNull: ["$totals.grandTotal", "$totalAmount"] },
              },
              orders: { $sum: 1 },
            },
          },
          { $sort: { "_id.year": 1, "_id.month": 1 } },
        ]).toArray(),

        // Daily revenue (last 14 days)
        Orders.aggregate([
          {
            $match: {
              $or: sellerIdMatch,
              status: { $ne: "cancelled" },
              createdAt: new Date(
                new Date().setDate(new Date().getDate() - 14)
              ),
            },
          },
          {
            $group: {
              _id: {
                day: { $dayOfMonth: "$createdAt" },
                month: { $month: "$createdAt" },
              },
              revenue: {
                $sum: { $ifNull: ["$totals.grandTotal", "$totalAmount"] },
              },
            },
          },
          { $sort: { "_id.month": 1, "_id.day": 1 } },
        ]).toArray(),

        // Returns / refunds counts
        Orders.aggregate([
          {
            $match: {
              $or: sellerIdMatch,
              status: {
                $in: ["return_requested", "returned", "refunded"],
              },
            },
          },
          {
            $group: {
              _id: "$status",
              count: { $sum: 1 },
            },
          },
        ]).toArray(),

        // Low stock products
        Products.countDocuments({
          userId: sellerIdStr,
          status: { $ne: "deleted" },
          $or: [{ stock: { $lte: 5 } }, { quantity: { $lte: 5 } }],
        }),

        // Today sales/orders
        Orders.aggregate([
          {
            $match: {
              $or: [
                { "items.sellerId": sellerIdStr },
                ...(sellerIdObj ? [{ "items.sellerId": sellerIdObj }] : []),
                { sellerId: sellerIdStr },
                ...(sellerIdObj ? [{ sellerId: sellerIdObj }] : []),
              ],
              status: { $ne: "cancelled" },
              createdAt: { $gte: todayStart },
            },
          },
          {
            $group: {
              _id: null,
              total: {
                $sum: { $ifNull: ["$totals.grandTotal", "$totalAmount"] },
              },
              orders: { $sum: 1 },
            },
          },
        ]).toArray(),

        // Week sales (last 7 days)
        Orders.aggregate([
          {
            $match: {
              $or: [
                { "items.sellerId": sellerIdStr },
                ...(sellerIdObj ? [{ "items.sellerId": sellerIdObj }] : []),
                { sellerId: sellerIdStr },
                ...(sellerIdObj ? [{ sellerId: sellerIdObj }] : []),
              ],
              status: { $ne: "cancelled" },
              createdAt: { $gte: sevenDaysAgo },
            },
          },
          {
            $group: {
              _id: null,
              total: {
                $sum: { $ifNull: ["$totals.grandTotal", "$totalAmount"] },
              },
              orders: { $sum: 1 },
            },
          },
        ]).toArray(),

        // Month sales (calendar month)
        Orders.aggregate([
          {
            $match: {
              $or: [
                { "items.sellerId": sellerIdStr },
                ...(sellerIdObj ? [{ "items.sellerId": sellerIdObj }] : []),
                { sellerId: sellerIdStr },
                ...(sellerIdObj ? [{ sellerId: sellerIdObj }] : []),
              ],
              status: { $ne: "cancelled" },
              createdAt: { $gte: monthStart },
            },
          },
          {
            $group: {
              _id: null,
              total: {
                $sum: { $ifNull: ["$totals.grandTotal", "$totalAmount"] },
              },
              orders: { $sum: 1 },
            },
          },
        ]).toArray(),
      ]);

      const sales = salesData[0] || { totalSales: 0, orderCount: 0 };
      const window = salesWindowAgg[0] || {
        totalRevenue: 0,
        orderCount: 0,
        totalItems: 0,
      };

      const returnsMap = {};
      (returnsAgg || []).forEach((r) => {
        returnsMap[String(r._id || "").toLowerCase()] = r.count || 0;
      });

      const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
      const weeklySales = dayNames.map((label, index) => {
        const dayData = weeklySalesData.find((d) => d._id === index + 1);
        return { label, value: dayData?.value || 0 };
      });

      const monthNames = [
        "Jan",
        "Feb",
        "Mar",
        "Apr",
        "May",
        "Jun",
        "Jul",
        "Aug",
        "Sep",
        "Oct",
        "Nov",
        "Dec",
      ];
      const monthlySales = (monthlySalesAgg || []).map((m) => ({
        label: `${monthNames[(m._id.month || 1) - 1]} '${String(
          m._id.year
        ).slice(-2)}`,
        revenue: Math.round(m.revenue || 0),
        orders: m.orders || 0,
      }));

      const dailySales = (dailySalesAgg || []).map((d) => ({
        label: `${d._id.month}/${d._id.day}`,
        revenue: Math.round(d.revenue || 0),
      }));

      const fulfillmentDenom =
        pendingOrders +
          processingOrders +
          shippedOrders +
          deliveredOrders +
          cancelledOrders || 1;
      const deliveredRate = Math.round(
        (deliveredOrders / fulfillmentDenom) * 100
      );
      const cancelRate = Math.round(
        (cancelledOrders / fulfillmentDenom) * 100
      );

      const todayStats = todayAgg[0] || { total: 0, orders: 0 };
      const weekStats = weekAgg[0] || { total: 0, orders: 0 };
      const monthStats = monthAgg[0] || { total: 0, orders: 0 };

      // 🔁 Normalize for mobile UI (SellerDashboardScreen.js)
      const recentOrders = (recentOrdersRaw || []).map((o) => {
        const total =
          (o.totals && (o.totals.grandTotal || o.totals.total)) ||
          o.totalAmount ||
          0;

        return {
          id: o._id?.toString?.() || o.orderNumber,
          orderNumber: o.orderNumber || o._id?.toString?.(),
          createdAt: o.createdAt,
          totalAmount: total,
          status: o.status || "pending",
          itemsCount: Array.isArray(o.items) ? o.items.length : 0,
        };
      });

      const topProducts = (topProductsAgg || []).map((p) => {
        const quantity = p.quantity || 0;
        const revenue = p.revenue || 0;
        const price =
          quantity > 0 ? Math.round(revenue / quantity) : 0;

        return {
          id: p._id?.toString?.(),
          name: p.name || "Product",
          totalSold: quantity,
          price,
          // For now, no direct image here; mobile will show placeholder
          thumbUrl: "",
        };
      });

      const storePayload = {
        id: sellerIdStr,
        name:
          seller?.storeName ||
          seller?.shopName ||
          seller?.name ||
          seller?.email ||
          "Your store",
        logoUrl: seller?.logoUrl || seller?.shopLogo || seller?.avatar || "",
        rating:
          Number(seller?.rating) ||
          Number(seller?.averageRating) ||
          Number(seller?.ratingAverage) ||
          0,
        totalProducts: Number(totalProducts || 0),
        status: seller?.status || "active",
        verified: !!(
          seller?.verified ||
          seller?.isVerified ||
          String(seller?.status || "").toLowerCase() === "verified"
        ),
      };

      const statsPayload = {
        todaySalesAmount: Math.round(todayStats.total || 0),
        todayOrdersCount: Number(todayStats.orders || 0),
        pendingOrdersCount: Number(pendingOrders || 0),
        thisWeekSalesAmount: Math.round(weekStats.total || 0),
        thisMonthSalesAmount: Math.round(monthStats.total || 0),
      };

      const ordersSummary = {
        pending: Number(pendingOrders || 0),
        processing: Number(processingOrders || 0),
        shipped: Number(shippedOrders || 0),
        delivered: Number(deliveredOrders || 0),
        cancelled: Number(cancelledOrders || 0),
      };

      const fulfillment = {
        deliveredRate,
        cancelRate,
        delivered: deliveredOrders,
        shipped: shippedOrders,
        processing: processingOrders,
        pending: pendingOrders,
        cancelled: cancelledOrders,
      };

      const returnsPayload = {
        return_requested: returnsMap["return_requested"] || 0,
        returned: returnsMap["returned"] || 0,
        refunded: returnsMap["refunded"] || 0,
      };

      const meta = {
        lowStockCount: Number(lowStockCount || 0),
        totalSales: sales.totalSales || 0,
        totalSales30d: Math.round(window.totalRevenue || 0),
        avgOrderValue30d:
          window.orderCount > 0
            ? Math.round((window.totalRevenue || 0) / window.orderCount)
            : 0,
        itemsSold30d: Math.round(window.totalItems || 0),
        totalOrders: Number(totalOrders || 0),
        totalProducts: Number(totalProducts || 0),
      };

      res.json({
        success: true,
        data: {
          store: storePayload,
          stats: statsPayload,
          ordersSummary,
          recentOrders,
          topProducts,
          weeklySales,
          monthlySales,
          dailySales,
          fulfillment,
          returns: returnsPayload,
          meta,

          // You can wire these later when you have messaging/notifications
          notificationsCount: 0,
          messagesCount: 0,
        },
      });
    } catch (error) {
      console.error("Seller dashboard error:", error);
      res
        .status(500)
        .json({ success: false, message: "Failed to load dashboard" });
    }
  }
);

/* ===============================
   DEVICE TOKEN REGISTER / UNREGISTER
   (for push notifications)
=============================== */
router.post("/device/register", authMiddleware, async (req, res) => {
  try {
    const { deviceToken, platform } = req.body;
    const userIdStr = String(req.userId || "").trim();

    if (!deviceToken || !platform) {
      return res.status(400).json({
        success: false,
        message: "Device token and platform are required",
      });
    }

    await db.collection("user_devices").updateOne(
      { userId: userIdStr, deviceToken },
      {
        $set: {
          userId: userIdStr,
          deviceToken,
          platform,
          updatedAt: new Date(),
        },
        $setOnInsert: {
          createdAt: new Date(),
        },
      },
      { upsert: true }
    );

    res.json({ success: true, message: "Device registered successfully" });
  } catch (error) {
    console.error("Device registration error:", error);
    res
      .status(500)
      .json({ success: false, message: "Failed to register device" });
  }
});

router.delete("/device/unregister", authMiddleware, async (req, res) => {
  try {
    const { deviceToken } = req.body;
    const userIdStr = String(req.userId || "").trim();

    if (!deviceToken) {
      return res.status(400).json({
        success: false,
        message: "Device token is required",
      });
    }

    await db
      .collection("user_devices")
      .deleteOne({ userId: userIdStr, deviceToken });

    res.json({ success: true, message: "Device unregistered successfully" });
  } catch (error) {
    console.error("Device unregistration error:", error);
    res
      .status(500)
      .json({ success: false, message: "Failed to unregister device" });
  }
});

export default router;
