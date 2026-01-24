import "dotenv/config";
import { getDB, closeMongo } from "../lib/mongo.js";

const db = await getDB();
const Locks = db.collection("gl_locks");

const idx = await Locks.indexes();
if (idx.some(i => i.name === "uniq_key")) {
  try { await Locks.dropIndex("uniq_key"); console.log("dropped uniq_key"); } catch {}
}

await Locks.createIndex({ key: 1 }, { name: "uniq_key", unique: true });
await Locks.createIndex({ expiresAt: 1 }, { name: "ttl_expiresAt", expireAfterSeconds: 0 });

console.log(JSON.stringify({ indexes: await Locks.indexes() }, null, 2));
await closeMongo();
