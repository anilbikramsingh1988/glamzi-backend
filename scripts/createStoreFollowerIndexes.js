import dotenv from "dotenv";
import { client } from "../dbConfig.js";

dotenv.config();

const DB_NAME = process.env.DB_NAME || "glamzi_ecommerce";
const db = client.db(DB_NAME);

async function run() {
  const followers = db.collection("storeFollowers");
  const events = db.collection("storeFollowerEvents");
  const daily = db.collection("storeFollowerDailyStats");
  const rateLimits = db.collection("storeFollowerRateLimits");

  await followers.createIndex(
    { sellerId: 1, customerId: 1 },
    { unique: true, partialFilterExpression: { status: "active" } }
  );
  await followers.createIndex({ sellerId: 1, status: 1, followedAt: -1 });
  await followers.createIndex({ customerId: 1, status: 1, followedAt: -1 });

  await events.createIndex({ sellerId: 1, at: -1 });
  await events.createIndex({ customerId: 1, at: -1 });

  await daily.createIndex({ sellerId: 1, dateKey: 1 }, { unique: true });

  await rateLimits.createIndex({ createdAt: 1 }, { expireAfterSeconds: 120 });

  console.log("Store follower indexes created");
  process.exit(0);
}

run().catch((err) => {
  console.error("Index creation failed:", err);
  process.exit(1);
});
