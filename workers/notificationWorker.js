import os from "os";
import { client } from "../dbConfig.js";
import { handleEvent, getSettings } from "../services/notifications/index.js";
import { emitDomainEvent } from "../services/events/emitDomainEvent.js";

const db = client.db(process.env.DB_NAME || "glamzi_ecommerce");
const DomainEvents = db.collection("domainEvents");
const DeadLetters = db.collection("notificationDeadLetters");

const LOCK_TTL_MS = Number(process.env.NOTIFY_LOCK_TTL_MS || 10 * 60 * 1000);
const MAX_ATTEMPTS = Number(process.env.NOTIFY_MAX_ATTEMPTS || 10);
const BATCH_LIMIT = Number(process.env.NOTIFY_BATCH_LIMIT || 25);
const POLL_MS = Number(process.env.NOTIFY_POLL_MS || 4000);
const WORKER_ID = `${os.hostname()}-${process.pid}`;

function backoffMs(attempts) {
  const base = 30 * 1000;
  const max = 60 * 60 * 1000;
  const ms = Math.min(max, base * Math.pow(2, Math.max(0, attempts - 1)));
  const jitter = Math.floor(Math.random() * 5000);
  return ms + jitter;
}

async function claimOne() {
  const now = new Date();
  const lockExpiry = new Date(now.getTime() - LOCK_TTL_MS);

  const res = await DomainEvents.findOneAndUpdate(
    {
      status: { $in: ["pending", "failed"] },
      attempts: { $lt: MAX_ATTEMPTS },
      nextAttemptAt: { $lte: now },
      $or: [{ lockedAt: null }, { lockedAt: { $lt: lockExpiry } }],
    },
    {
      $set: {
        status: "processing",
        lockedAt: now,
        lockId: WORKER_ID,
        updatedAt: now,
      },
      $inc: { attempts: 1 },
    },
    { sort: { nextAttemptAt: 1, createdAt: 1 }, returnDocument: "after" }
  );
  return res?.value || null;
}

async function markProcessed(event, note = null) {
  await DomainEvents.updateOne(
    { _id: event._id },
    {
      $set: {
        status: "processed",
        processedAt: new Date(),
        failReason: note,
        updatedAt: new Date(),
      },
    }
  );
}

async function markFailed(event, err) {
  const nextAttemptAt = new Date(Date.now() + backoffMs(event.attempts || 1));
  await DomainEvents.updateOne(
    { _id: event._id },
    {
      $set: {
        status: "failed",
        failReason: String(err?.message || err),
        nextAttemptAt,
        updatedAt: new Date(),
      },
    }
  );
}

async function markDead(event, err) {
  await DomainEvents.updateOne(
    { _id: event._id },
    {
      $set: {
        status: "dead",
        failReason: String(err?.message || err),
        updatedAt: new Date(),
      },
    }
  );
  await DeadLetters.insertOne({
    eventId: event._id,
    type: event.type,
    dedupeKey: event.dedupeKey,
    failReason: String(err?.message || err),
    payloadSnapshot: event.payload || {},
    lastAttemptAt: new Date(),
    attempts: event.attempts || 0,
    createdAt: new Date(),
  });
}

async function processOne() {
  const event = await claimOne();
  if (!event) return false;
  // eslint-disable-next-line no-console
  console.log("[notify-worker][claim]", {
    eventId: String(event._id || ""),
    type: event.type,
    attempts: event.attempts || 0,
  });

  try {
    const settings = await getSettings();
    if (settings.emailEnabledByType?.[event.type] === false) {
      await markProcessed(event, "disabled_by_settings");
      return true;
    }

    const res = await handleEvent(event);
    // eslint-disable-next-line no-console
    console.log("[notify-worker][handled]", {
      eventId: String(event._id || ""),
      type: event.type,
      skipped: Boolean(res?.skipped),
      reason: res?.reason || null,
    });
    if (res?.skipped) {
      await markProcessed(event, res.reason || "skipped");
    } else {
      await markProcessed(event);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[notify-worker][error]", {
      eventId: String(event?._id || ""),
      type: event?.type,
      error: err?.message || String(err),
    });
    if ((event.attempts || 1) >= MAX_ATTEMPTS) {
      await markDead(event, err);
    } else {
      await markFailed(event, err);
    }
  }

  return true;
}

export async function runWorker({ once = false } = {}) {
  // eslint-disable-next-line no-console
  console.log(`[notify-worker] started ${WORKER_ID}`);

  do {
    let processed = 0;
    for (let i = 0; i < BATCH_LIMIT; i += 1) {
      const ok = await processOne();
      if (!ok) break;
      processed += 1;
    }
    if (once) break;
    if (processed === 0) {
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  } while (true);
}

if (process.argv[1] && process.argv[1].includes("notificationWorker.js")) {
  const once = process.argv.includes("--once");
  runWorker({ once }).catch((err) => {
    // eslint-disable-next-line no-console
    console.error("[notify-worker] crashed:", err);
    process.exit(1);
  });
}
