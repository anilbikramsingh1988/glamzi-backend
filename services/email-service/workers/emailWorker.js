import dotenv from "dotenv";
import { v4 as uuidv4 } from "uuid";
import { connectDb } from "../db.js";
import { renderEmail } from "../services/templates/templateEngine.js";
import { sendEmail } from "../services/providers/sendgrid.js";

dotenv.config();

const LOCK_TTL_MS = Number(process.env.EMAIL_WORKER_LOCK_TTL_MS || 10 * 60 * 1000);
const POLL_MS = Number(process.env.EMAIL_WORKER_POLL_MS || 4000);

const PRIORITY_RANK = { critical: 0, high: 1, normal: 2, low: 3 };

function redactEmail(email) {
  if (!email) return "";
  const [name, domain] = String(email).split("@");
  if (!domain) return "redacted";
  return `${name?.[0] || "*"}***@${domain}`;
}

function backoffMs(attempts) {
  const base = 30 * 1000;
  const max = 60 * 60 * 1000;
  const ms = Math.min(max, base * Math.pow(2, Math.max(0, attempts - 1)));
  const jitter = Math.floor(Math.random() * 5000);
  return ms + jitter;
}

async function claimJob(db, lockId) {
  const now = new Date();
  const lockExpiry = new Date(now.getTime() - LOCK_TTL_MS);

  const jobs = db.collection("emailJobs");

  const res = await jobs.findOneAndUpdate(
    {
      status: { $in: ["queued", "failed"] },
      nextAttemptAt: { $lte: now },
      $or: [{ lockedAt: null }, { lockedAt: { $lt: lockExpiry } }],
    },
    {
      $set: { status: "sending", lockedAt: now, lockId, updatedAt: now },
      $inc: { attempts: 1 },
    },
    { sort: { priorityRank: 1, nextAttemptAt: 1, createdAt: 1 }, returnDocument: "after" }
  );

  return res.value || null;
}

async function markSent(db, job, providerMessageId) {
  await db.collection("emailJobs").updateOne(
    { _id: job._id },
    {
      $set: {
        status: "sent",
        providerMessageId: providerMessageId || null,
        sentAt: new Date(),
        updatedAt: new Date(),
      },
    }
  );
}

async function markFailed(db, job, err, maxAttempts) {
  const attempts = job.attempts || 1;
  if (attempts >= maxAttempts) {
    await markDead(db, job, err);
    return;
  }

  const nextAttemptAt = new Date(Date.now() + backoffMs(attempts));
  await db.collection("emailJobs").updateOne(
    { _id: job._id },
    {
      $set: {
        status: "failed",
        nextAttemptAt,
        lastError: { code: err?.code || "SEND", message: String(err?.message || err) },
        updatedAt: new Date(),
      },
    }
  );
}

async function markDead(db, job, err) {
  await db.collection("emailJobs").updateOne(
    { _id: job._id },
    {
      $set: {
        status: "dead",
        lastError: { code: err?.code || "SEND", message: String(err?.message || err) },
        updatedAt: new Date(),
      },
    }
  );

  await db.collection("emailDeadLetters").insertOne({
    jobId: job._id,
    type: job.type,
    idempotencyKey: job.idempotencyKey,
    payloadSnapshot: job,
    lastAttemptAt: new Date(),
    attempts: job.attempts || 0,
    createdAt: new Date(),
  });
}

async function getSettings(db) {
  return (
    (await db.collection("emailSettings").findOne({ _id: "default" })) || {
      enabled: true,
      enabledByType: {},
      limits: { maxAttempts: 10 },
    }
  );
}

async function processOne(db, lockId) {
  const settings = await getSettings(db);
  if (!settings.enabled) return false;

  const job = await claimJob(db, lockId);
  if (!job) return false;

  const maxAttempts = settings.limits?.maxAttempts || 10;

  try {
    if (settings.enabledByType?.[job.type] === false) {
      await db.collection("emailJobs").updateOne(
        { _id: job._id },
        { $set: { status: "cancelled", updatedAt: new Date(), lastError: { code: "DISABLED", message: "Type disabled" } } }
      );
      return true;
    }

    let html = job.html;
    if (!html && job.templateId) {
      const rendered = renderEmail({ templateId: job.templateId, variables: job.variables || {} });
      html = rendered.html;
    }

    const result = await sendEmail({
      from: job.from,
      replyTo: job.replyTo,
      to: job.to,
      cc: job.cc,
      bcc: job.bcc,
      subject: job.subject,
      html,
      text: job.text,
      attachments: job.attachments,
      customArgs: { jobId: String(job._id) },
      category: job.type,
    });

    await markSent(db, job, result.messageId);
    console.log(JSON.stringify({
      level: "info",
      msg: "Email sent",
      jobId: String(job._id),
      to: job.to.map(redactEmail),
    }));
  } catch (err) {
    console.error(JSON.stringify({ level: "error", msg: "Email send failed", jobId: String(job._id), error: err?.message || err }));
    await markFailed(db, job, err, maxAttempts);
  }

  return true;
}

async function run({ once = false } = {}) {
  const db = await connectDb();

  // normalize priority for sort
  await db.collection("emailJobs").updateMany(
    { priorityRank: { $exists: false } },
    [{ $set: { priorityRank: { $ifNull: ["$priorityRank", { $ifNull: ["$priority", "normal"] }] } } }]
  );

  const lockId = uuidv4();

  do {
    let processed = 0;
    for (let i = 0; i < 25; i += 1) {
      const ok = await processOne(db, lockId);
      if (!ok) break;
      processed += 1;
    }
    if (once) break;
    if (processed === 0) {
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  } while (true);
}

if (process.argv[1] && process.argv[1].includes("emailWorker.js")) {
  const once = process.argv.includes("--once");
  run({ once }).catch((err) => {
    console.error(JSON.stringify({ level: "error", msg: "Worker crashed", error: err?.message || err }));
    process.exit(1);
  });
}

export { run, backoffMs, claimJob };
