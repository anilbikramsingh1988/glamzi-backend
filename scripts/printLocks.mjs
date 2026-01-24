import "dotenv/config";
import { getDB, closeMongo } from "../lib/mongo.js";

const db = await getDB();

const locks = await db.collection("gl_locks")
  .find({}, { projection: { _id: 1, key: 1, owner: 1, runId: 1, acquiredAt: 1, expiresAt: 1, releasedAt: 1, updatedAt: 1 } })
  .sort({ updatedAt: -1 })
  .limit(50)
  .toArray();

console.log(JSON.stringify({ count: locks.length, locks }, null, 2));

await closeMongo();
