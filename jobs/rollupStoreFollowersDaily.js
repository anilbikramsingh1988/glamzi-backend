import dotenv from "dotenv";
import { DateTime } from "luxon";
import { ObjectId } from "mongodb";

import { client } from "../dbConfig.js";
import { FOLLOW_TZ } from "../utils/storeFollowUtils.js";

dotenv.config();

const DB_NAME = process.env.DB_NAME || "glamzi_ecommerce";
const db = client.db(DB_NAME);
const Followers = db.collection("storeFollowers");
const Events = db.collection("storeFollowerEvents");
const DailyStats = db.collection("storeFollowerDailyStats");

const normalizeDateKey = (value) =>
  String(value || "").trim();

function getTargetDateKey() {
  const arg = process.argv.find((v) => v.startsWith("--date="));
  if (arg) return normalizeDateKey(arg.split("=")[1]);
  return DateTime.now().setZone(FOLLOW_TZ).minus({ days: 1 }).toFormat("yyyy-LL-dd");
}

function getDayRange(dateKey) {
  const start = DateTime.fromFormat(dateKey, "yyyy-LL-dd", { zone: FOLLOW_TZ }).startOf("day");
  const end = start.endOf("day");
  return { start: start.toJSDate(), end: end.toJSDate() };
}

async function computeTotalsForDay(sellerId, end) {
  return Followers.countDocuments({
    sellerId: String(sellerId),
    status: "active",
    followedAt: { $lte: end },
    $or: [{ unfollowedAt: null }, { unfollowedAt: { $gt: end } }],
  });
}

async function run() {
  const dateKey = getTargetDateKey();
  if (!dateKey) {
    console.error("Missing dateKey");
    process.exit(1);
  }

  const { start, end } = getDayRange(dateKey);

  const eventAgg = await Events.aggregate([
    {
      $match: {
        at: { $gte: start, $lte: end },
      },
    },
    {
      $group: {
        _id: { sellerId: "$sellerId", type: "$type" },
        count: { $sum: 1 },
      },
    },
  ]).toArray();

  const sellerStats = new Map();
  eventAgg.forEach((row) => {
    const sellerId = row._id?.sellerId;
    if (!sellerId) return;
    if (!sellerStats.has(sellerId)) {
      sellerStats.set(sellerId, { added: 0, lost: 0 });
    }
    const stats = sellerStats.get(sellerId);
    if (row._id.type === "follow") stats.added += row.count;
    if (row._id.type === "unfollow") stats.lost += row.count;
  });

  for (const [sellerId, stats] of sellerStats.entries()) {
    const totalSnapshot = await computeTotalsForDay(sellerId, end);
    const net = stats.added - stats.lost;
    const now = new Date();

    await DailyStats.updateOne(
      { sellerId: String(sellerId), dateKey },
      {
        $set: {
          sellerId: String(sellerId),
          dateKey,
          followersAdded: stats.added,
          followersLost: stats.lost,
          followersNet: net,
          followersTotalSnapshot: totalSnapshot,
          updatedAt: now,
        },
        $setOnInsert: { createdAt: now },
      },
      { upsert: true }
    );
  }

  console.log(
    `Rollup complete for ${dateKey}. Sellers updated: ${sellerStats.size}`
  );
  process.exit(0);
}

run().catch((err) => {
  console.error("Rollup failed:", err);
  process.exit(1);
});
