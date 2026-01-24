import "dotenv/config";
import { getDB, closeMongo } from "../lib/mongo.js";

const db = await getDB();

const r = await db.collection("gl_locks").deleteMany({
  key: { $regex: "^daily_close_" }
});

console.log("deleted", r.deletedCount);

await closeMongo();
