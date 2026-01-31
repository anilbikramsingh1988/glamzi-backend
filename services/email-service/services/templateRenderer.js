import mjml2html from "mjml";
import Handlebars from "handlebars";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { connectDb } from "../db.js";
import { mergeTransactionalBlocks } from "./templateMerger.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const baseTemplatePath = path.resolve(__dirname, "..", "templates", "emails", "_base_reference.mjml");
let cachedBaseHead = null;

function loadBaseHead() {
  if (cachedBaseHead !== null) return cachedBaseHead;
  if (!fs.existsSync(baseTemplatePath)) {
    cachedBaseHead = "";
    return cachedBaseHead;
  }
  const raw = fs.readFileSync(baseTemplatePath, "utf-8");
  const match = raw.match(/<mj-head>([\s\S]*?)<\/mj-head>/i);
  cachedBaseHead = match ? match[1].trim() : "";
  return cachedBaseHead;
}

function applyBaseHead(mjmlRaw) {
  if (!mjmlRaw) return mjmlRaw;
  if (mjmlRaw.includes("glamzi-base-head")) return mjmlRaw;
  const baseHead = loadBaseHead();
  if (!baseHead) return mjmlRaw;

  if (mjmlRaw.includes("<mj-head>")) {
    return mjmlRaw.replace("<mj-head>", `<mj-head>\n${baseHead}\n`);
  }

  return mjmlRaw.replace("<mjml>", `<mjml>\n  <mj-head>\n${baseHead}\n  </mj-head>`);
}

function normalizeMjmlClasses(mjmlRaw) {
  if (!mjmlRaw) return mjmlRaw;
  // MJML expects css-class; normalize any legacy class attributes.
  return mjmlRaw
    .replace(/\bclass="/g, 'css-class="')
    .replace(/\bclass='/g, "css-class='");
}

export async function renderTemplateByKey({ templateKey, variables = {} }) {
  const db = await connectDb();
  const settings = (await db.collection("emailSettings").findOne({ _id: "default" })) || {};
  const template = await db.collection("emailTemplates").findOne({ key: templateKey });
  if (!template) {
    return { ok: false, error: { code: "NOT_FOUND", message: "Template not found" } };
  }

  const version = await db
    .collection("emailTemplateVersions")
    .findOne({ templateKey, status: "published" }, { sort: { version: -1 } });

  if (!version) {
    return { ok: false, error: { code: "NO_PUBLISHED", message: "No published version" } };
  }

  const allowedVars = new Set(template.allowedVariables || []);
  const unknown = Object.keys(variables || {}).filter((k) => !allowedVars.has(k));
  if (unknown.length > 0) {
    return { ok: false, error: { code: "INVALID_VARIABLES", message: "Unknown variables", details: unknown } };
  }

  const globalDefaults = {
    brandName: settings.brandName || "Glamzi",
    brandLogoUrl: settings.brandLogoUrl || "",
    brandPrimaryColor: settings.brandPrimaryColor || "#F22A83",
    brandSecondaryColor: settings.brandSecondaryColor || "#FFE3F0",
    supportEmail: settings.supportEmail || "support@glamzibeauty.com",
    supportPhone: settings.supportPhone || "",
    footerNotice: settings.footerNotice || "✓ FREE DELIVERY ✓ FREE RETURNS",
    appUrl: settings.appUrl || "https://glamzibeauty.com",
    year: new Date().getFullYear(),
  };

  const mergedVariables = { ...globalDefaults, ...variables };

  let mjmlRaw = "";
  if (template.isBlockEditable) {
    mjmlRaw = mergeTransactionalBlocks({
      contentBlocks: version.contentBlocks || {},
      variables: { ...mergedVariables, previewText: version.previewText || "" },
    });
  } else {
    mjmlRaw = version.mjmlRaw || "";
  }

  const compiled = Handlebars.compile(normalizeMjmlClasses(applyBaseHead(mjmlRaw)));
  const hydrated = compiled(mergedVariables);
  const { html, errors } = mjml2html(hydrated, { validationLevel: "soft" });

  return {
    ok: true,
    html,
    errors,
    template,
    version,
    subject: version.subject,
    previewText: version.previewText,
  };
}
