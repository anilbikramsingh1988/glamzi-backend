import express from "express";
import { ObjectId } from "mongodb";
import { z } from "zod";

import { connectDb } from "../db.js";
import { resolveRouting, isQuietHoursNow, shouldRespectQuietHours, getNextQuietHoursEnd, isSuppressed } from "../services/routing/emailRouter.js";

const router = express.Router();

const enqueueSchema = z.object({
  type: z.string().min(1),
  priority: z.enum(["low", "normal", "high", "critical"]).optional(),
  idempotencyKey: z.string().min(5),
  fromKey: z.string().optional(),
  to: z.array(z.string().email()).min(1),
  cc: z.array(z.string().email()).optional(),
  bcc: z.array(z.string().email()).optional(),
  subject: z.string().min(1),
  templateId: z.string().optional(),
  variables: z.record(z.any()).optional(),
  text: z.string().optional(),
  html: z.string().optional(),
  attachments: z
    .array(
      z.object({
        filename: z.string().min(1),
        contentType: z.string().min(1),
        contentBase64: z.string().min(1),
      })
    )
    .optional(),
  links: z.object({ reportUrl: z.string().url().optional() }).optional(),
  meta: z
    .object({
      sourceService: z.string().optional(),
      traceId: z.string().optional(),
      actorRole: z.string().optional(),
      actorId: z.string().optional(),
      refs: z.record(z.any()).optional(),
    })
    .optional(),
});

function requireInternalToken(req, res, next) {
  const token = req.headers["x-internal-token"];
  if (!process.env.EMAIL_SERVICE_INTERNAL_TOKEN) {
    return res.status(500).json({ ok: false, error: { code: "CONFIG", message: "Internal token not configured" } });
  }
  if (!token || token !== process.env.EMAIL_SERVICE_INTERNAL_TOKEN) {
    return res.status(401).json({ ok: false, error: { code: "UNAUTHORIZED", message: "Missing or invalid token" } });
  }
  return next();
}

async function getSettings(db) {
  const settings = await db.collection("emailSettings").findOne({ _id: "default" });
  return (
    settings || {
      _id: "default",
      enabled: true,
      enabledByType: {},
      fromProfiles: {},
      quietHours: { enabled: false, startHour: 22, endHour: 8, timeZone: "Asia/Kathmandu" },
      suppression: { blockedDomains: [], blockedEmails: [] },
      limits: { maxTo: 50, maxAttachmentBytes: 10 * 1024 * 1024, maxAttempts: 10 },
    }
  );
}

function sumAttachmentBytes(attachments = []) {
  let total = 0;
  for (const att of attachments) {
    const len = Buffer.byteLength(att.contentBase64 || "", "base64");
    total += len;
  }
  return total;
}

const PRIORITY_RANK = { critical: 0, high: 1, normal: 2, low: 3 };

router.post("/enqueue", requireInternalToken, async (req, res) => {
  const parse = enqueueSchema.safeParse(req.body || {});
  if (!parse.success) {
    return res.status(400).json({ ok: false, error: { code: "VALIDATION", message: "Invalid payload", details: parse.error.flatten() } });
  }

  const payload = parse.data;
  const db = await connectDb();
  const settings = await getSettings(db);

  if (!settings.enabled) {
    return res.status(503).json({ ok: false, error: { code: "DISABLED", message: "Email service disabled" } });
  }

  if (settings.enabledByType?.[payload.type] === false) {
    return res.status(403).json({ ok: false, error: { code: "TYPE_DISABLED", message: "Email type disabled" } });
  }

  const allRecipients = [...payload.to, ...(payload.cc || []), ...(payload.bcc || [])];
  if (isSuppressed(settings, allRecipients)) {
    const job = {
      status: "cancelled",
      channel: "email",
      priority: payload.priority || "normal",
      type: payload.type,
      idempotencyKey: payload.idempotencyKey,
      to: payload.to,
      subject: payload.subject,
      templateId: payload.templateId || null,
      variables: payload.variables || {},
      meta: payload.meta || {},
      createdAt: new Date(),
      updatedAt: new Date(),
      lastError: { code: "SUPPRESSED", message: "Recipient suppressed" },
    };
    await db.collection("emailJobs").insertOne(job).catch(() => {});
    return res.status(200).json({ ok: true, status: "suppressed" });
  }

  if (payload.to.length > (settings.limits?.maxTo || 50)) {
    return res.status(400).json({ ok: false, error: { code: "LIMIT", message: "Too many recipients" } });
  }

  if (payload.attachments && sumAttachmentBytes(payload.attachments) > (settings.limits?.maxAttachmentBytes || 10 * 1024 * 1024)) {
    return res.status(400).json({ ok: false, error: { code: "LIMIT", message: "Attachments too large" } });
  }

  const routing = resolveRouting(payload, settings);

  let nextAttemptAt = new Date();
  if (shouldRespectQuietHours(payload.type) && isQuietHoursNow(settings)) {
    nextAttemptAt = getNextQuietHoursEnd(settings);
  }

  const priority = payload.priority || "normal";
  const job = {
    status: "queued",
    channel: "email",
    priority,
    priorityRank: PRIORITY_RANK[priority] ?? 2,
    type: payload.type,
    idempotencyKey: payload.idempotencyKey,
    fromKey: routing.fromKey,
    from: routing.from,
    replyTo: routing.replyTo || undefined,
    to: payload.to,
    cc: payload.cc || [],
    bcc: payload.bcc || [],
    subject: payload.subject,
    templateId: payload.templateId || null,
    variables: payload.variables || {},
    text: payload.text || null,
    html: payload.html || null,
    attachments: payload.attachments || [],
    links: payload.links || {},
    meta: payload.meta || {},
    provider: "sendgrid",
    attempts: 0,
    nextAttemptAt,
    lockedAt: null,
    lockId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  try {
    const result = await db.collection("emailJobs").insertOne(job);
    return res.status(201).json({ ok: true, jobId: result.insertedId });
  } catch (err) {
    if (err?.code === 11000) {
      const existing = await db.collection("emailJobs").findOne({ idempotencyKey: payload.idempotencyKey });
      return res.status(200).json({ ok: true, status: "already_queued", jobId: existing?._id });
    }
    return res.status(500).json({ ok: false, error: { code: "DB", message: "Failed to enqueue job" } });
  }
});

router.get("/jobs", requireInternalToken, async (req, res) => {
  const db = await connectDb();
  const filter = {};
  if (req.query.status) filter.status = req.query.status;
  if (req.query.type) filter.type = req.query.type;
  if (req.query.fromKey) filter.fromKey = req.query.fromKey;

  const from = req.query.from ? new Date(req.query.from) : null;
  const to = req.query.to ? new Date(req.query.to) : null;
  if (from || to) {
    filter.createdAt = {};
    if (from) filter.createdAt.$gte = from;
    if (to) filter.createdAt.$lte = to;
  }

  const page = Math.max(Number(req.query.page || 1), 1);
  const limit = Math.min(Math.max(Number(req.query.limit || 20), 1), 100);
  const skip = (page - 1) * limit;

  const items = await db.collection("emailJobs").find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).toArray();
  const total = await db.collection("emailJobs").countDocuments(filter);

  return res.json({ ok: true, items, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
});

router.get("/jobs/:id", requireInternalToken, async (req, res) => {
  const db = await connectDb();
  const id = req.params.id;
  const job = await db.collection("emailJobs").findOne({ _id: new ObjectId(id) });
  if (!job) return res.status(404).json({ ok: false, error: { code: "NOT_FOUND", message: "Job not found" } });
  return res.json({ ok: true, job });
});

router.post("/jobs/:id/retry", requireInternalToken, async (req, res) => {
  const db = await connectDb();
  const id = req.params.id;
  const now = new Date();
  const result = await db.collection("emailJobs").updateOne(
    { _id: new ObjectId(id) },
    { $set: { status: "queued", nextAttemptAt: now, lockedAt: null, lockId: null, updatedAt: now } }
  );
  if (!result.matchedCount) return res.status(404).json({ ok: false, error: { code: "NOT_FOUND", message: "Job not found" } });
  return res.json({ ok: true });
});

router.post("/jobs/:id/cancel", requireInternalToken, async (req, res) => {
  const db = await connectDb();
  const id = req.params.id;
  const now = new Date();
  const result = await db.collection("emailJobs").updateOne(
    { _id: new ObjectId(id) },
    { $set: { status: "cancelled", updatedAt: now } }
  );
  if (!result.matchedCount) return res.status(404).json({ ok: false, error: { code: "NOT_FOUND", message: "Job not found" } });
  return res.json({ ok: true });
});

router.get("/settings", requireInternalToken, async (req, res) => {
  const db = await connectDb();
  const settings = await getSettings(db);
  return res.json({ ok: true, settings });
});

router.put("/settings", requireInternalToken, async (req, res) => {
  const db = await connectDb();
  const now = new Date();
  const body = req.body || {};
  const existing = await getSettings(db);

  const next = {
    _id: "default",
    enabled: typeof body.enabled === "boolean" ? body.enabled : existing.enabled,
    enabledByType: body.enabledByType || existing.enabledByType,
    fromProfiles: body.fromProfiles || existing.fromProfiles,
    quietHours: body.quietHours || existing.quietHours,
    suppression: body.suppression || existing.suppression,
    limits: body.limits || existing.limits,
    createdAt: existing.createdAt || now,
    updatedAt: now,
  };

  await db.collection("emailSettings").updateOne({ _id: "default" }, { $set: next }, { upsert: true });
  return res.json({ ok: true, settings: next });
});

export default router;
