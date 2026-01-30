import os from "os";
import { client } from "../dbConfig.js";
import { notifySeller, notifyCustomer, notifyAdmin } from "../utils/notify.js";

const db = client.db(process.env.DB_NAME || "glamzi_ecommerce");
const Outbox = db.collection("outbox");

const WORKER_ID = `${os.hostname()}-${process.pid}`;
const MAX_ATTEMPTS = Number(process.env.OUTBOX_MAX_ATTEMPTS || 8);
const BATCH_LIMIT = Number(process.env.OUTBOX_BATCH_LIMIT || 25);
const POLL_MS = Number(process.env.OUTBOX_POLL_MS || 5000);

function backoffMs(attempts) {
  const base = 30 * 1000; // 30s
  const max = 30 * 60 * 1000; // 30m
  const ms = Math.min(max, base * Math.pow(2, Math.max(0, attempts - 1)));
  return ms;
}

async function processOne() {
  const now = new Date();
  const claimed = await Outbox.findOneAndUpdate(
    {
      status: { $in: ["pending", "failed"] },
      attempts: { $lt: MAX_ATTEMPTS },
      nextRunAt: { $lte: now },
      $or: [{ lockedAt: null }, { lockedAt: { $lt: new Date(now.getTime() - 10 * 60 * 1000) } }],
    },
    {
      $set: { status: "processing", lockedAt: now, lockedBy: WORKER_ID, updatedAt: now },
      $inc: { attempts: 1 },
    },
    { sort: { nextRunAt: 1, createdAt: 1 }, returnDocument: "after" }
  );

  const job = claimed?.value;
  if (!job) return false;

  try {
    const type = String(job.type || "");
    const payload = job.payload || {};

    if (type === "notify.seller") {
      await notifySeller(payload);
    } else if (type === "notify.customer") {
      await notifyCustomer(payload);
    } else if (type === "notify.admin") {
      await notifyAdmin(payload);
    } else {
      throw new Error(`Unknown outbox type: ${type}`);
    }

    await Outbox.updateOne(
      { _id: job._id },
      {
        $set: {
          status: "done",
          processedAt: new Date(),
          lastError: null,
          updatedAt: new Date(),
        },
      }
    );
  } catch (err) {
    const nextRunAt = new Date(Date.now() + backoffMs(job.attempts || 1));
    await Outbox.updateOne(
      { _id: job._id },
      {
        $set: {
          status: "failed",
          lastError: String(err?.message || err),
          nextRunAt,
          updatedAt: new Date(),
        },
      }
    );
  }

  return true;
}

export async function processOutboxBatch(limit = BATCH_LIMIT) {
  let processed = 0;
  for (let i = 0; i < limit; i += 1) {
    const ok = await processOne();
    if (!ok) break;
    processed += 1;
  }
  return processed;
}

async function run() {
  // eslint-disable-next-line no-console
  console.log(`[outbox] worker started (${WORKER_ID})`);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const count = await processOutboxBatch(BATCH_LIMIT);
    if (count === 0) {
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  }
}

if (process.argv[1] && process.argv[1].includes("outboxWorker.js")) {
  run().catch((err) => {
    // eslint-disable-next-line no-console
    console.error("[outbox] worker crashed:", err);
    process.exit(1);
  });
}
