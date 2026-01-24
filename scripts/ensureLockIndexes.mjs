import "dotenv/config";
import { getDB, closeMongo } from "../lib/mongo.js";

const db = await getDB();
const Locks = db.collection("gl_locks");

// Unique key (safe if already exists)
try {
  await Locks.createIndex({ key: 1 }, { name: "uniq_key", unique: true });
} catch (e) {
  // ignore if exists
}

// TTL index: expiresAt must be a Date, expireAfterSeconds must be 0
try {
  await Locks.createIndex({ expiresAt: 1 }, { name: "ttl_expiresAt", expireAfterSeconds: 0 });
} catch (e) {
  // ignore if exists
}

const indexes = await Locks.indexes();
console.log(JSON.stringify({ indexes }, null, 2));

await closeMongo();
