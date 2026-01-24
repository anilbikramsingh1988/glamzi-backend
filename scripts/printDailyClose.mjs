import "dotenv/config";
import { getDB, closeMongo } from "../lib/mongo.js";

const db = await getDB();
const businessDate = process.argv[2] || "2026-01-16";

const doc = await db.collection("gl_daily_closes").findOne(
  { businessDate },
  { projection: { businessDate: 1, status: 1, runId: 1, closedAt: 1, startedAt: 1, failedAt: 1, window: 1, "audit.ledgerCount": 1 } }
);

console.log(JSON.stringify({ businessDate, close: doc }, null, 2));
await closeMongo();
