import mjml2html from "mjml";
import Handlebars from "handlebars";

import { connectDb } from "../db.js";
import { mergeTransactionalBlocks } from "./templateMerger.js";

export async function renderTemplateByKey({ templateKey, variables = {} }) {
  const db = await connectDb();
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

  let mjmlRaw = "";
  if (template.isBlockEditable) {
    mjmlRaw = mergeTransactionalBlocks({ contentBlocks: version.contentBlocks || {}, variables: { ...variables, previewText: version.previewText || "" } });
  } else {
    mjmlRaw = version.mjmlRaw || "";
  }

  const compiled = Handlebars.compile(mjmlRaw);
  const hydrated = compiled(variables);
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
