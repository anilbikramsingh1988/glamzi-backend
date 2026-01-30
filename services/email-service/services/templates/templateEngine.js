import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import mjml2html from "mjml";
import Handlebars from "handlebars";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const templatesRoot = path.resolve(__dirname, "..", "..", "templates", "emails");

const cache = new Map();

function loadTemplate(name) {
  if (cache.has(name)) return cache.get(name);
  const filePath = path.join(templatesRoot, `${name}.mjml`);
  const raw = fs.readFileSync(filePath, "utf-8");
  const compiled = Handlebars.compile(raw, { noEscape: true });
  cache.set(name, compiled);
  return compiled;
}

function renderTemplate(name, variables = {}) {
  const compiled = loadTemplate(name);
  return compiled(variables);
}

export function renderEmail({ templateId, variables = {} }) {
  const body = renderTemplate(templateId, variables);
  const layout = renderTemplate("base", { ...variables, body });
  const { html, errors } = mjml2html(layout, { validationLevel: "soft" });
  return { html, errors };
}

export function clearTemplateCache() {
  cache.clear();
}
