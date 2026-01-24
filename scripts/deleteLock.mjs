import "dotenv/config";
import { getDB, closeMongo } from "../lib/mongo.js";

const db = await getDB();

const key = "daily_close_2026-01-16";
const r = await db.collection("gl_locks").deleteOne({ key });

console.log(JSON.stringify({ deletedCount: r.deletedCount, key }, null, 2));

await closeMongo();
