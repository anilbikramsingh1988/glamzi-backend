import "dotenv/config";
import { getDB, closeMongo } from "../lib/mongo.js";

const db = await getDB();
const Locks = db.collection("gl_locks");

const exact = await Locks.findOne(
  { key: "daily_close_2026-01-16" },
  { projection: { _id: 1, key: 1, owner: 1, runId: 1, acquiredAt: 1, expiresAt: 1, releasedAt: 1, updatedAt: 1 } }
);

const regex = await Locks.find(
  { key: { $regex: "^daily_close_" } },
  { projection: { _id: 1, key: 1, owner: 1, runId: 1, acquiredAt: 1, expiresAt: 1, releasedAt: 1, updatedAt: 1 } }
).sort({ updatedAt: -1 }).limit(50).toArray();

// Also find docs where key might be stored under another field or as non-string
const anyMention = await Locks.find(
  {
    $or: [
      { key: { $regex: "2026-01-16" } },
      { owner: { $regex: "40477960-02d5-4ba0-8ea5-ecadf00d99dc" } }, // your close runId (useful correlation)
      { runId: "40477960-02d5-4ba0-8ea5-ecadf00d99dc" }
    ]
  },
  { projection: { _id: 1, key: 1, owner: 1, runId: 1, acquiredAt: 1, expiresAt: 1, releasedAt: 1, updatedAt: 1 } }
).sort({ updatedAt: -1 }).limit(50).toArray();

console.log(JSON.stringify({ exact, regexCount: regex.length, regex, anyMentionCount: anyMention.length, anyMention }, null, 2));
await closeMongo();
