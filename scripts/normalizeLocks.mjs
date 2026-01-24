import "dotenv/config";
import { getDB, closeMongo } from "../lib/mongo.js";

const db = await getDB();
const Locks = db.collection("gl_locks");

// Convert expiresAt string -> Date using pipeline update.
// Only touches docs where expiresAt is stored as string.
const res = await Locks.updateMany(
  { expiresAt: { $type: "string" } },
  [
    { $set: { expiresAt: { $toDate: "$expiresAt" } } }
  ]
);

console.log(JSON.stringify({
  matched: res.matchedCount,
  modified: res.modifiedCount
}, null, 2));

await closeMongo();
