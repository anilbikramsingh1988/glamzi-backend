import express from "express";
import { ObjectId } from "mongodb";
import { z } from "zod";
import mjml2html from "mjml";
import Handlebars from "handlebars";

import { connectDb } from "../db.js";
import { adminAuthMiddleware } from "../../../routes/adminRoutes.js";
import { mergeTransactionalBlocks } from "../services/templateMerger.js";
import { sendEmail } from "../services/providers/sendgrid.js";

const router = express.Router();

function requireInternalToken(req) {
  const token = req.headers["x-internal-token"];
  if (!process.env.EMAIL_SERVICE_INTERNAL_TOKEN) return false;
  return Boolean(token && token === process.env.EMAIL_SERVICE_INTERNAL_TOKEN);
}

function requireAdminOrInternal(req, res, next) {
  if (requireInternalToken(req)) return next();
  return adminAuthMiddleware(req, res, next);
}

const templateRegistrySchema = z.object({
  key: z.string().min(3),
  category: z.enum(["transactional", "operational", "marketing"]),
  fromKey: z.string().min(1).optional(),
  allowedVariables: z.array(z.string()).default([]),
  isBlockEditable: z.boolean().default(false),
  isMarketing: z.boolean().optional(),
});

const contentBlocksSchema = z.object({
  headerText: z.string().max(500).optional(),
  bodyText: z.string().max(5000).optional(),
  ctaLabel: z.string().max(120).optional(),
  ctaUrl: z.string().url().optional(),
  footerText: z.string().max(500).optional(),
  previewText: z.string().max(200).optional(),
});

const versionSchema = z.object({
  subject: z.string().max(200),
  previewText: z.string().max(200).optional(),
  mjmlRaw: z.string().max(150000).optional(),
  contentBlocks: contentBlocksSchema.optional(),
  changeNote: z.string().max(500).optional(),
});

function buildSampleVariables(allowed = []) {
  const vars = {};
  allowed.forEach((v) => {
    vars[v] = v.replace(/_/g, " ");
  });
  return vars;
}

function parseVarsParam(value) {
  if (!value) return {};
  try {
    const json = Buffer.from(String(value), "base64").toString("utf-8");
    return JSON.parse(json);
  } catch (err) {
    return null;
  }
}

async function buildMjmlFromVersion(template, version, variables) {
  if (template.isBlockEditable) {
    return mergeTransactionalBlocks({ contentBlocks: version.contentBlocks || {}, variables: { ...variables, previewText: version.previewText || "" } });
  }
  return version.mjmlRaw || "";
}

router.get("/", requireAdminOrInternal, async (req, res) => {
  const db = await connectDb();
  const templates = await db.collection("emailTemplates").find({}).sort({ key: 1 }).toArray();
  const keys = templates.map((t) => t.key);

  const latest = await db.collection("emailTemplateVersions")
    .aggregate([
      { $match: { templateKey: { $in: keys } } },
      { $sort: { version: -1 } },
      { $group: { _id: "$templateKey", latest: { $first: "$ROOT" } } },
    ])
    .toArray();

  const latestMap = new Map(latest.map((row) => [row._id, row.latest]));

  const data = templates.map((t) => ({
    ...t,
    latestVersion: latestMap.get(t.key) || null,
  }));

  res.json({ ok: true, data });
});

router.post("/", requireAdminOrInternal, async (req, res) => {
  const parse = templateRegistrySchema.safeParse(req.body || {});
  if (!parse.success) {
    return res.status(400).json({ ok: false, error: { code: "VALIDATION", message: "Invalid registry", details: parse.error.flatten() } });
  }

  const db = await connectDb();
  const payload = parse.data;

  const doc = {
    key: payload.key,
    category: payload.category,
    fromKey: payload.fromKey || null,
    allowedVariables: payload.allowedVariables || [],
    isBlockEditable: payload.isBlockEditable,
    isMarketing: payload.isMarketing || payload.category === "marketing",
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  try {
    await db.collection("emailTemplates").insertOne(doc);
    res.status(201).json({ ok: true, data: doc });
  } catch (err) {
    if (err?.code === 11000) {
      return res.status(409).json({ ok: false, error: { code: "DUPLICATE", message: "Template key already exists" } });
    }
    return res.status(500).json({ ok: false, error: { code: "DB", message: "Failed to create template" } });
  }
});

router.get("/:templateKey/versions", requireAdminOrInternal, async (req, res) => {
  const db = await connectDb();
  const list = await db.collection("emailTemplateVersions").find({ templateKey: req.params.templateKey }).sort({ version: -1 }).toArray();
  res.json({ ok: true, data: list });
});

router.post("/:templateKey/versions", requireAdminOrInternal, async (req, res) => {
  const parse = versionSchema.safeParse(req.body || {});
  if (!parse.success) {
    return res.status(400).json({ ok: false, error: { code: "VALIDATION", message: "Invalid version", details: parse.error.flatten() } });
  }

  const db = await connectDb();
  const templateKey = req.params.templateKey;
  const template = await db.collection("emailTemplates").findOne({ key: templateKey });
  if (!template) return res.status(404).json({ ok: false, error: { code: "NOT_FOUND", message: "Template not found" } });

  const latest = await db.collection("emailTemplateVersions").findOne({ templateKey }, { sort: { version: -1 } });
  const nextVersion = (latest?.version || 0) + 1;

  const payload = parse.data;
  if (template.isBlockEditable && !payload.contentBlocks) {
    return res.status(400).json({ ok: false, error: { code: "VALIDATION", message: "contentBlocks required for transactional templates" } });
  }
  if (!template.isBlockEditable && !payload.mjmlRaw) {
    return res.status(400).json({ ok: false, error: { code: "VALIDATION", message: "mjmlRaw required for marketing templates" } });
  }

  if (!template.isBlockEditable && payload.mjmlRaw) {
    const compiled = mjml2html(payload.mjmlRaw, { validationLevel: "soft" });
    if (compiled.errors?.length) {
      return res.status(400).json({ ok: false, error: { code: "MJML", message: "MJML validation errors", details: compiled.errors } });
    }
  }

  const doc = {
    templateKey,
    version: nextVersion,
    status: "draft",
    subject: payload.subject,
    previewText: payload.previewText || "",
    mjmlRaw: payload.mjmlRaw || null,
    contentBlocks: payload.contentBlocks || null,
    fallbackHtml: null,
    createdBy: req.body?.createdBy || "admin",
    changeNote: payload.changeNote || "",
    createdAt: new Date(),
  };

  await db.collection("emailTemplateVersions").insertOne(doc);
  res.status(201).json({ ok: true, data: doc });
});

router.get("/:templateKey/versions/:version/preview", requireAdminOrInternal, async (req, res) => {
  const db = await connectDb();
  const templateKey = req.params.templateKey;
  const version = Number(req.params.version);

  const template = await db.collection("emailTemplates").findOne({ key: templateKey });
  const ver = await db.collection("emailTemplateVersions").findOne({ templateKey, version });

  if (!template || !ver) return res.status(404).json({ ok: false, error: { code: "NOT_FOUND", message: "Template or version not found" } });

  const parsedVars = parseVarsParam(req.query.vars);
  if (parsedVars === null) {
    return res.status(400).json({ ok: false, error: { code: "VALIDATION", message: "Invalid vars payload" } });
  }

  const variables = parsedVars && Object.keys(parsedVars).length
    ? parsedVars
    : buildSampleVariables(template.allowedVariables || []);

  const mjmlRaw = await buildMjmlFromVersion(template, ver, variables);
  const compiled = Handlebars.compile(mjmlRaw)(variables);
  const { html, errors } = mjml2html(compiled, { validationLevel: "soft" });

  res.json({ ok: true, data: { html, errors: errors || [] } });
});

router.post("/:templateKey/versions/:version/test-send", requireAdminOrInternal, async (req, res) => {
  const db = await connectDb();
  const templateKey = req.params.templateKey;
  const version = Number(req.params.version);

  const template = await db.collection("emailTemplates").findOne({ key: templateKey });
  const ver = await db.collection("emailTemplateVersions").findOne({ templateKey, version });

  if (!template || !ver) return res.status(404).json({ ok: false, error: { code: "NOT_FOUND", message: "Template or version not found" } });

  const to = Array.isArray(req.body?.to) ? req.body.to : [];
  if (to.length === 0) {
    return res.status(400).json({ ok: false, error: { code: "VALIDATION", message: "Recipient list required" } });
  }

  const variables = req.body?.variables || buildSampleVariables(template.allowedVariables || []);
  const mjmlRaw = await buildMjmlFromVersion(template, ver, variables);
  const compiled = Handlebars.compile(mjmlRaw)(variables);
  const { html } = mjml2html(compiled, { validationLevel: "soft" });

  await sendEmail({
    to,
    from: { email: template.fromKey ? `${template.fromKey}@glamzibeauty.com` : "no-reply@glamzibeauty.com", name: "Glamzi" },
    subject: ver.subject,
    html,
    text: ver.previewText || "",
  });

  res.json({ ok: true });
});

router.post("/:templateKey/versions/:version/publish", requireAdminOrInternal, async (req, res) => {
  const db = await connectDb();
  const templateKey = req.params.templateKey;
  const version = Number(req.params.version);

  const ver = await db.collection("emailTemplateVersions").findOne({ templateKey, version });
  if (!ver) return res.status(404).json({ ok: false, error: { code: "NOT_FOUND", message: "Version not found" } });

  await db.collection("emailTemplateVersions").updateMany({ templateKey, status: "published" }, { $set: { status: "archived" } });
  await db.collection("emailTemplateVersions").updateOne({ templateKey, version }, { $set: { status: "published", publishedAt: new Date() } });
  await db.collection("emailTemplates").updateOne({ key: templateKey }, { $set: { updatedAt: new Date() } });

  res.json({ ok: true });
});

router.post("/:templateKey/versions/:version/rollback", requireAdminOrInternal, async (req, res) => {
  const db = await connectDb();
  const templateKey = req.params.templateKey;
  const version = Number(req.params.version);

  const template = await db.collection("emailTemplates").findOne({ key: templateKey });
  const ver = await db.collection("emailTemplateVersions").findOne({ templateKey, version });
  if (!template || !ver) return res.status(404).json({ ok: false, error: { code: "NOT_FOUND", message: "Template or version not found" } });

  const latest = await db.collection("emailTemplateVersions").findOne({ templateKey }, { sort: { version: -1 } });
  const nextVersion = (latest?.version || 0) + 1;

  const doc = {
    templateKey,
    version: nextVersion,
    status: "draft",
    subject: ver.subject,
    previewText: ver.previewText || "",
    mjmlRaw: ver.mjmlRaw || null,
    contentBlocks: ver.contentBlocks || null,
    fallbackHtml: ver.fallbackHtml || null,
    createdBy: req.body?.createdBy || "admin",
    changeNote: req.body?.changeNote || `Rollback from v${version}`,
    createdAt: new Date(),
    rollbackFromVersion: version,
  };

  await db.collection("emailTemplateVersions").insertOne(doc);
  res.status(201).json({ ok: true, data: doc });
});

export default router;
