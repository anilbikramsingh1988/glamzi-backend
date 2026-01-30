import express from "express";
import dotenv from "dotenv";
import { DateTime } from "luxon";
import { ObjectId } from "mongodb";

import { client } from "../dbConfig.js";
import {
  authMiddleware,
  isCustomerMiddleware,
  isSellerMiddleware,
  isActiveMiddleware,
} from "../middlewares/authMiddleware.js";
import { ensureAdminRole } from "../middlewares/staffGuard.js";
import { buildSellerSummaryResponse, FOLLOW_TZ } from "../utils/storeFollowUtils.js";

dotenv.config();

const router = express.Router();

const getDb = () => client.db(process.env.DB_NAME || "glamzi");
const getFollowers = () => getDb().collection("storeFollowers");
const getEvents = () => getDb().collection("storeFollowerEvents");
const getDailyStats = () => getDb().collection("storeFollowerDailyStats");
const getRateLimits = () => getDb().collection("storeFollowerRateLimits");
const getUsers = () => getDb().collection("users");
const getSellers = () => getDb().collection("sellers");

const ERROR = (res, status, code, message) =>
  res.status(status).json({ error: { code, message } });

const ok = (res, data = {}) => res.json({ ok: true, ...data });

const normalizeId = (value) => String(value || "").trim();

const isValidSellerId = (value) => {
  const trimmed = normalizeId(value);
  if (!trimmed) return false;
  if (ObjectId.isValid(trimmed)) return true;
  // Allow canonical string IDs (fallback), keep strict charset to avoid garbage input
  return /^[a-zA-Z0-9_-]{3,64}$/.test(trimmed);
};

const isSelfFollow = (sellerId, customerId) =>
  normalizeId(sellerId) && normalizeId(sellerId) === normalizeId(customerId);

const getMeta = (req, source) => ({
  source,
  userAgent: String(req.headers["user-agent"] || ""),
  ip:
    String(req.headers["x-forwarded-for"] || "")
      .split(",")[0]
      .trim() || req.ip || "",
});

async function rateLimitFollow(customerId, limit = 30) {
  try {
    const now = new Date();
    const windowKey = Math.floor(Date.now() / 60000);
    const key = `${customerId}:${windowKey}`;

    const res = await getRateLimits().findOneAndUpdate(
      { key },
      { $inc: { count: 1 }, $setOnInsert: { key, count: 0, createdAt: now } },
      { upsert: true, returnDocument: "after" }
    );

    return (res?.value?.count || 0) <= limit;
  } catch (err) {
    console.error("rateLimitFollow failed, allowing request:", err);
    return true;
  }
}

async function recordEvent({ sellerId, customerId, type, source, meta }) {
  try {
    const at = new Date();
    await getEvents().insertOne({
      sellerId: String(sellerId),
      customerId: String(customerId),
      type,
      source,
      meta,
      at,
      createdAt: at,
    });
  } catch (err) {
    console.error("recordEvent failed:", err);
  }
}

async function ensureSellerExists(sellerId) {
  try {
    const idStr = normalizeId(sellerId);
    if (!idStr) return false;

    const sellerOid = ObjectId.isValid(idStr) ? new ObjectId(idStr) : null;
    const sellers = getSellers();
    const users = getUsers();

    const sellerDoc =
      (await sellers.findOne(
        sellerOid
          ? { $or: [{ _id: sellerOid }, { sellerId: idStr }, { userId: idStr }] }
          : { $or: [{ sellerId: idStr }, { userId: idStr }] },
        { projection: { _id: 1 } }
      )) ||
      (await users.findOne(
        sellerOid
          ? { $or: [{ _id: sellerOid }, { sellerId: idStr }, { userId: idStr }], role: "seller" }
          : { $or: [{ sellerId: idStr }, { userId: idStr }], role: "seller" },
        { projection: { _id: 1 } }
      ));

    return Boolean(sellerDoc);
  } catch (err) {
    console.error("ensureSellerExists failed:", err);
    return false;
  }
}

function getDateKeyRange(days = 30) {
  const end = DateTime.now().setZone(FOLLOW_TZ).startOf("day");
  const start = end.minus({ days: days - 1 });
  const dates = [];
  for (let i = 0; i < days; i += 1) {
    dates.push(start.plus({ days: i }).toFormat("yyyy-LL-dd"));
  }
  return { start, end, dates };
}

async function buildDailySeriesFromEvents(sellerId, days = 30) {
  const { start, end, dates } = getDateKeyRange(days);
  const startDate = start.toJSDate();
  const endDate = end.plus({ days: 1 }).toJSDate();

  const events = await getEvents()
    .aggregate([
      {
        $match: {
          sellerId: String(sellerId),
          at: { $gte: startDate, $lt: endDate },
        },
      },
      {
        $group: {
          _id: {
            dateKey: {
              $dateToString: {
                format: "%Y-%m-%d",
                date: "$at",
                timezone: FOLLOW_TZ,
              },
            },
            type: "$type",
          },
          count: { $sum: 1 },
        },
      },
    ])
    .toArray();

  const map = {};
  events.forEach((row) => {
    const dateKey = row._id?.dateKey;
    if (!dateKey) return;
    if (!map[dateKey]) map[dateKey] = { added: 0, lost: 0 };
    if (row._id.type === "follow") map[dateKey].added += row.count;
    if (row._id.type === "unfollow") map[dateKey].lost += row.count;
  });

  const series = [];
  for (const dateKey of dates) {
    const added = map[dateKey]?.added || 0;
    const lost = map[dateKey]?.lost || 0;
    const net = added - lost;

    const dayEnd = DateTime.fromFormat(dateKey, "yyyy-LL-dd", {
      zone: FOLLOW_TZ,
    })
      .endOf("day")
      .toJSDate();

    const totalSnapshot = await getFollowers().countDocuments({
      sellerId: String(sellerId),
      status: "active",
      followedAt: { $lte: dayEnd },
      $or: [{ unfollowedAt: null }, { unfollowedAt: { $gt: dayEnd } }],
    });

    series.push({ dateKey, added, lost, net, totalSnapshot });
  }

  return series;
}

async function buildDailySeries(sellerId) {
  const { dates } = getDateKeyRange(30);
  const stats = await getDailyStats()
    .find({ sellerId: String(sellerId), dateKey: { $in: dates } })
    .toArray();

  if (stats.length === 0) {
    return buildDailySeriesFromEvents(sellerId);
  }

  const map = {};
  stats.forEach((row) => {
    map[row.dateKey] = {
      dateKey: row.dateKey,
      added: row.followersAdded || 0,
      lost: row.followersLost || 0,
      net: row.followersNet || 0,
      totalSnapshot: row.followersTotalSnapshot || 0,
    };
  });

  return dates.map((dateKey) => map[dateKey] || {
    dateKey,
    added: 0,
    lost: 0,
    net: 0,
    totalSnapshot: 0,
  });
}

// ===========================
// CUSTOMER ROUTES
// ===========================
router.post(
  "/:sellerId/follow",
  authMiddleware,
  isCustomerMiddleware,
  isActiveMiddleware,
  async (req, res) => {
    try {
      const sellerId = normalizeId(req.params.sellerId);
      const customerId = normalizeId(req.user?.id);

      if (!sellerId || !isValidSellerId(sellerId)) {
        return ERROR(res, 400, "INVALID_SELLER_ID", "Invalid seller ID");
      }

      if (!customerId) {
        return ERROR(res, 401, "UNAUTHORIZED", "Invalid customer session");
      }

      if (isSelfFollow(sellerId, customerId)) {
        return ERROR(
          res,
          400,
          "SELF_FOLLOW_NOT_ALLOWED",
          "You cannot follow your own store"
        );
      }

      const canProceed = await rateLimitFollow(customerId);
      if (!canProceed) {
        return ERROR(res, 429, "RATE_LIMITED", "Too many follow requests");
      }

      const sellerExists = await ensureSellerExists(sellerId);
      if (!sellerExists) {
        return ERROR(res, 404, "SELLER_NOT_FOUND", "Seller not found");
      }

      const followers = getFollowers();
      const now = new Date();

      const active = await followers.findOne({
        sellerId,
        customerId,
        status: "active",
      });

      if (active) {
        return ok(res, { status: "already_following" });
      }

      try {
        await followers.updateOne(
          { sellerId, customerId },
          {
            $set: {
              status: "active",
              followedAt: now,
              unfollowedAt: null,
              updatedAt: now,
              meta: getMeta(req, "web"),
            },
            $setOnInsert: { createdAt: now },
          },
          { upsert: true }
        );
      } catch (err) {
        if (err?.code === 11000) {
          return ok(res, { status: "already_following" });
        }
        throw err;
      }

      await recordEvent({
        sellerId,
        customerId,
        type: "follow",
        source: "web",
        meta: getMeta(req, "web"),
      });

      return ok(res, { status: "followed" });
    } catch (err) {
      console.error("POST /store/:sellerId/follow error:", err);
      return ERROR(res, 500, "FOLLOW_FAILED", "Failed to follow store");
    }
  }
);

router.post(
  "/:sellerId/unfollow",
  authMiddleware,
  isCustomerMiddleware,
  isActiveMiddleware,
  async (req, res) => {
    try {
      const sellerId = normalizeId(req.params.sellerId);
      const customerId = normalizeId(req.user?.id);

      if (!sellerId || !isValidSellerId(sellerId)) {
        return ERROR(res, 400, "INVALID_SELLER_ID", "Invalid seller ID");
      }

      if (!customerId) {
        return ERROR(res, 401, "UNAUTHORIZED", "Invalid customer session");
      }

      const active = await getFollowers().findOne({
        sellerId,
        customerId,
        status: "active",
      });

      if (!active) {
        return ok(res, { status: "already_unfollowed" });
      }

      const now = new Date();
      await getFollowers().updateOne(
        { sellerId, customerId, status: "active" },
        {
          $set: {
            status: "unfollowed",
            unfollowedAt: now,
            updatedAt: now,
          },
        }
      );

      await recordEvent({
        sellerId,
        customerId,
        type: "unfollow",
        source: "web",
        meta: getMeta(req, "web"),
      });

      return ok(res, { status: "unfollowed" });
    } catch (err) {
      console.error("POST /store/:sellerId/unfollow error:", err);
      return ERROR(res, 500, "UNFOLLOW_FAILED", "Failed to unfollow store");
    }
  }
);

router.get(
  "/:sellerId/following-status",
  authMiddleware,
  isCustomerMiddleware,
  isActiveMiddleware,
  async (req, res) => {
    try {
      const sellerId = normalizeId(req.params.sellerId);
      const customerId = normalizeId(req.user?.id);

      if (!sellerId || !isValidSellerId(sellerId)) {
        return ERROR(res, 400, "INVALID_SELLER_ID", "Invalid seller ID");
      }

      if (!customerId) {
        return ERROR(res, 401, "UNAUTHORIZED", "Invalid customer session");
      }

      const active = await getFollowers().findOne({
        sellerId,
        customerId,
        status: "active",
      });

      return res.json({ isFollowing: Boolean(active) });
    } catch (err) {
      console.error("GET /store/:sellerId/following-status error:", err);
      return ERROR(res, 500, "STATUS_FAILED", "Failed to load follow status");
    }
  }
);

router.get(
  "/my/following",
  authMiddleware,
  isCustomerMiddleware,
  isActiveMiddleware,
  async (req, res) => {
    try {
      const customerId = normalizeId(req.user?.id);
      if (!customerId) {
        return ERROR(res, 401, "UNAUTHORIZED", "Invalid customer session");
      }

      const page = Math.max(1, Number(req.query.page) || 1);
      const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
      const skip = (page - 1) * limit;

      const [items, total] = await Promise.all([
        getFollowers()
          .find({ customerId, status: "active" })
          .sort({ followedAt: -1 })
          .skip(skip)
          .limit(limit)
          .toArray(),
        getFollowers().countDocuments({ customerId, status: "active" }),
      ]);

      const sellerIds = [...new Set(items.map((row) => row.sellerId))];
      const sellerObjectIds = sellerIds
        .filter((id) => ObjectId.isValid(id))
        .map((id) => new ObjectId(id));

      const [sellerDocs, userDocs] = await Promise.all([
        sellerIds.length
          ? getSellers()
              .find(
                {
                  $or: [
                    { sellerId: { $in: sellerIds } },
                    ...(sellerObjectIds.length ? [{ _id: { $in: sellerObjectIds } }] : []),
                  ],
                },
                {
                  projection: {
                    _id: 1,
                    sellerId: 1,
                    storeName: 1,
                    shopName: 1,
                    logoUrl: 1,
                    rating: 1,
                    ratingCount: 1,
                    description: 1,
                    storeDescription: 1,
                  },
                }
              )
              .toArray()
          : [],
        sellerIds.length
          ? getUsers()
              .find(
                {
                  role: "seller",
                  $or: [
                    { sellerId: { $in: sellerIds } },
                    ...(sellerObjectIds.length ? [{ _id: { $in: sellerObjectIds } }] : []),
                  ],
                },
                {
                  projection: {
                    _id: 1,
                    sellerId: 1,
                    storeName: 1,
                    shopName: 1,
                    logoUrl: 1,
                    rating: 1,
                    ratingCount: 1,
                    description: 1,
                    storeDescription: 1,
                  },
                }
              )
              .toArray()
          : [],
      ]);

      const map = {};
      const normalize = (doc) => {
        const sid = String(doc.sellerId || doc._id || "");
        if (!sid) return;
        map[sid] = {
          sellerId: sid,
          storeName: doc.storeName || doc.shopName || "Store",
          logoUrl: doc.logoUrl || null,
          rating: typeof doc.rating === "number" ? doc.rating : 0,
          ratingCount: doc.ratingCount || 0,
          description: doc.description || doc.storeDescription || "",
        };
      };

      sellerDocs.forEach(normalize);
      userDocs.forEach((doc) => {
        const sid = String(doc.sellerId || doc._id || "");
        if (!map[sid]) normalize(doc);
      });

      const data = items.map((row) => ({
        sellerId: row.sellerId,
        followedAt: row.followedAt,
        seller: map[row.sellerId] || null,
      }));

      return res.json({
        items: data,
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      });
    } catch (err) {
      console.error("GET /store/my/following error:", err);
      return ERROR(res, 500, "FOLLOWING_FAILED", "Failed to load following list");
    }
  }
);

// ===========================
// SELLER ROUTES
// ===========================
router.get(
  "/seller/me/followers/summary",
  authMiddleware,
  isSellerMiddleware,
  isActiveMiddleware,
  async (req, res) => {
    try {
      const sellerId = normalizeId(req.user?.id);
      if (!sellerId) {
        return ERROR(res, 401, "UNAUTHORIZED", "Invalid seller session");
      }

      const totalFollowers = await getFollowers().countDocuments({
        sellerId,
        status: "active",
      });

      const series = await buildDailySeries(sellerId);
      const last7Days = series.slice(-7).reduce((sum, row) => sum + row.net, 0);
      const last30Days = series.reduce((sum, row) => sum + row.net, 0);

      return res.json(
        buildSellerSummaryResponse({
          totalFollowers,
          last7Days,
          last30Days,
          series,
        })
      );
    } catch (err) {
      console.error("GET /store/seller/me/followers/summary error:", err);
      return ERROR(res, 500, "SUMMARY_FAILED", "Failed to load followers summary");
    }
  }
);

// ===========================
// ADMIN ROUTES
// ===========================
router.get(
  "/admin/followers",
  authMiddleware,
  ensureAdminRole(),
  async (req, res) => {
    try {
      const {
        sellerId,
        customerId,
        status,
        from,
        to,
        page = 1,
        limit = 20,
      } = req.query;

      const filter = {};
      if (sellerId) filter.sellerId = String(sellerId);
      if (customerId) filter.customerId = String(customerId);
      if (status) filter.status = String(status);
      if (from || to) {
        filter.followedAt = {};
        if (from) filter.followedAt.$gte = new Date(from);
        if (to) filter.followedAt.$lte = new Date(to);
      }

      const pageNum = Math.max(1, Number(page) || 1);
      const limitNum = Math.min(100, Math.max(1, Number(limit) || 20));
      const skip = (pageNum - 1) * limitNum;

      const [items, total] = await Promise.all([
        getFollowers()
          .find(filter, {
            projection: {
              sellerId: 1,
              customerId: 1,
              status: 1,
              followedAt: 1,
              unfollowedAt: 1,
              createdAt: 1,
              updatedAt: 1,
            },
          })
          .sort({ followedAt: -1 })
          .skip(skip)
          .limit(limitNum)
          .toArray(),
        getFollowers().countDocuments(filter),
      ]);

      return res.json({
        items,
        total,
        page: pageNum,
        limit: limitNum,
        totalPages: Math.ceil(total / limitNum),
      });
    } catch (err) {
      console.error("GET /store/admin/followers error:", err);
      return ERROR(res, 500, "ADMIN_LIST_FAILED", "Failed to load followers");
    }
  }
);

router.get(
  "/admin/sellers/:sellerId/followers",
  authMiddleware,
  ensureAdminRole(),
  async (req, res) => {
    try {
      const sellerId = normalizeId(req.params.sellerId);
      if (!sellerId) {
        return ERROR(res, 400, "INVALID_SELLER_ID", "Invalid seller ID");
      }

      const pageNum = Math.max(1, Number(req.query.page) || 1);
      const limitNum = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
      const skip = (pageNum - 1) * limitNum;

      const [items, total] = await Promise.all([
        getFollowers()
          .find(
            { sellerId },
            {
              projection: {
                sellerId: 1,
                customerId: 1,
                status: 1,
                followedAt: 1,
                unfollowedAt: 1,
                createdAt: 1,
                updatedAt: 1,
              },
            }
          )
          .sort({ followedAt: -1 })
          .skip(skip)
          .limit(limitNum)
          .toArray(),
        getFollowers().countDocuments({ sellerId }),
      ]);

      return res.json({
        items,
        total,
        page: pageNum,
        limit: limitNum,
        totalPages: Math.ceil(total / limitNum),
      });
    } catch (err) {
      console.error("GET /store/admin/sellers/:sellerId/followers error:", err);
      return ERROR(res, 500, "ADMIN_SELLER_FAILED", "Failed to load seller followers");
    }
  }
);

export default router;
