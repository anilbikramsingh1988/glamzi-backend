#!/usr/bin/env node
import "dotenv/config"; // Load .env in ESM mode

import { getDB, closeMongo, debugMongoEnv } from "../lib/mongo.js";
import {
  parseBusinessDateOrThrow,
  defaultBusinessDateKathmanduYesterday,
  businessDayWindowUtc,
  makeRunId,
  nowUtcDate,
} from "../lib/time.js";
import { acquireLock, releaseLock, makeLockOwner } from "../lib/lock.js";
import { computeDailyCloseFromLedger } from "../lib/dailyClose.js";

/* --------------------- CLI arg parsing --------------------- */

function parseArgs(argv) {
  const args = {};
  for (const a of argv.slice(2)) {
    const [k, v] = a.split("=");
    if (k.startsWith("--")) {
      const key = k.slice(2);
      args[key] = v === undefined ? true : v;
    }
  }
  return args;
}

function boolish(v) {
  if (v === true) return true;
  const s = String(v || "").trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "y";
}

/* --------------------- Daily close helpers --------------------- */

async function upsertRunningClose({ db, businessDate, window, runId }) {
  const Coll = db.collection("gl_daily_closes");
  const now = nowUtcDate();

  const existing = await Coll.findOne({ businessDate, status: "closed" });
  if (existing) return { alreadyClosed: true, doc: existing };

  const res = await Coll.findOneAndUpdate(
    { businessDate },
    {
      $setOnInsert: {
        businessDate,
        createdAt: now,
      },
      $set: {
        status: "running",
        runId,
        startedAt: now,
        updatedAt: now,
        window: {
          businessDate,
          fromUtc: window.fromUtc,
          toUtc: window.toUtc,
          fromUtcISO: window.fromUtcISO,
          toUtcISO: window.toUtcISO,
          tz: "Asia/Kathmandu",
        },
      },
    },
    { upsert: true, returnDocument: "after" }
  );

  return { alreadyClosed: false, doc: res.value };
}

async function finalizeClose({ db, businessDate, runId, computed }) {
  const Coll = db.collection("gl_daily_closes");
  const now = nowUtcDate();

  const res = await Coll.findOneAndUpdate(
    { businessDate, runId, status: "running" },
    {
      $set: {
        status: "closed",
        totals: computed.totals,
        perAccount: computed.perAccount,
        audit: computed.audit,
        updatedAt: now,
        closedAt: now,
      },
    },
    { returnDocument: "after" }
  );

  return res.value;
}

async function failClose({ db, businessDate, runId, err }) {
  const Coll = db.collection("gl_daily_closes");
  await Coll.updateOne(
    { businessDate, runId },
    {
      $set: {
        status: "failed",
        error: {
          message: err?.message || String(err),
          stack: err?.stack || null,
        },
        failedAt: new Date(),
        updatedAt: new Date(),
      },
    }
  );
}

/* --------------------- Main worker --------------------- */

async function main() {
  const args = parseArgs(process.argv);

  // Determine business date
  const bizDate = args.date
    ? parseBusinessDateOrThrow(String(args.date))
    : defaultBusinessDateKathmanduYesterday();

  const window = businessDayWindowUtc(bizDate);
  const businessDate = window.businessDate;
  const runId = makeRunId();
  const owner = makeLockOwner();

  // DB connection
  const db = await getDB();
  console.log("[dailyCloseWorker] mongoEnv", debugMongoEnv());

  // Idempotency gate: if already closed, exit 0 (do NOT acquire lock)
  const existingClosed = await db.collection("gl_daily_closes").findOne(
    { businessDate, status: "closed" },
    { projection: { _id: 1, runId: 1, closedAt: 1, "audit.ledgerCount": 1 } }
  );

  if (existingClosed) {
    console.log(
      `[dailyCloseWorker] ALREADY_CLOSED businessDate=${businessDate} runId=${existingClosed.runId} ledgerCount=${existingClosed.audit?.ledgerCount ?? "?"}`
    );
    await closeMongo();
    return;
  }

  // Lock key
  const lockKey = `daily_close_${businessDate}`;
  const leaseMs = Number(process.env.DAILY_CLOSE_LEASE_MS || 10 * 60 * 1000);

  console.log("[dailyCloseWorker] lockKey", lockKey);

  let lock = null;
  try {
    // Acquire distributed lock
    lock = await acquireLock({
      db,
      key: lockKey,
      owner,
      runId,
      leaseMs,
    });

    if (!lock?.ok) {
      console.log("[dailyCloseWorker] Lock not acquired:", lock?.reason || "LOCK_HELD");
      return;
    }

    // Mark “running”
    const { alreadyClosed } = await upsertRunningClose({
      db,
      businessDate,
      window,
      runId,
    });

    if (alreadyClosed) {
      console.log(`[dailyCloseWorker] Already closed for ${businessDate}`);
      await closeMongo();
      return;
    }

    // Compute totals from ledger
    const computed = await computeDailyCloseFromLedger({
      db,
      fromUtc: window.fromUtc,
      toUtc: window.toUtc,
    });

    // Finalize
    const finalDoc = await finalizeClose({
      db,
      businessDate,
      runId,
      computed,
    });

    console.log(
      `[dailyCloseWorker] SUCCESS businessDate=${businessDate} ledgerCount=${computed.audit.ledgerCount}`
    );

    // Optionally enqueue report job
    if (boolish(args.enqueueReport)) {
      await db.collection("gl_report_jobs").updateOne(
        { type: "daily_statement_export", businessDate },
        {
          $setOnInsert: {
            type: "daily_statement_export",
            businessDate,
            window,
            status: "queued",
            createdAt: new Date(),
          },
          $set: { updatedAt: new Date() },
        },
        { upsert: true }
      );
    }
  } catch (err) {
    console.error(`[dailyCloseWorker] FAILED`, err);
    await failClose({ db, businessDate, runId, err });
    process.exitCode = 1;
  } finally {
    if (lock?.ok) {
      try {
        await releaseLock({ db, key: lockKey, owner });
      } catch (e) {
        console.error("[dailyCloseWorker] WARN lock release failed", e?.message || e);
      }
    }
    await closeMongo();
  }
}

main().catch((err) => {
  console.error("[dailyCloseWorker] Unhandled", err);
  process.exitCode = 1;
});
