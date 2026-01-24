#!/usr/bin/env node
import "dotenv/config";

import { getDB, closeMongo, debugMongoEnv } from "../lib/mongo.js";
import { ensureSettlementIndexes, processSettlementRunFromClose } from "../lib/settlement.js";

async function processBacklog(db) {
  const closes = await db
    .collection("gl_daily_closes")
    .find({ status: "closed" })
    .sort({ _id: -1 })
    .limit(Number(process.env.SETTLEMENT_BACKLOG_LIMIT || 10))
    .toArray();

  for (const doc of closes) {
    await processSettlementRunFromClose({ db, closeDoc: doc, log: console });
  }
}

async function main() {
  const db = await getDB();
  console.log("[dailySettlementWorker] mongoEnv", debugMongoEnv());
  await ensureSettlementIndexes(db);

  // Process recent backlog once at startup
  await processBacklog(db);

  const closes = db.collection("gl_daily_closes");
  const pipeline = [
    { $match: { operationType: "insert", "fullDocument.status": "closed" } },
  ];

  const stream = closes.watch(pipeline, { fullDocument: "default" });

  stream.on("change", async (change) => {
    try {
      const doc = change.fullDocument || change.documentKey;
      await processSettlementRunFromClose({ db, closeDoc: doc, log: console });
    } catch (err) {
      console.error("[dailySettlementWorker] stream handler error", err);
    }
  });

  stream.on("error", (err) => {
    console.error("[dailySettlementWorker] change stream error", err);
  });

  process.on("SIGINT", async () => {
    console.log("[dailySettlementWorker] shutting down");
    try {
      await stream.close();
    } catch (e) {
      console.error("[dailySettlementWorker] stream close error", e?.message || e);
    }
    await closeMongo();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("[dailySettlementWorker] fatal", err);
  process.exit(1);
});
