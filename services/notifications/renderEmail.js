import fs from "fs";
import path from "path";
import mjml2html from "mjml";
import Handlebars from "handlebars";

const templatesDir = path.resolve("templates", "emails");

function loadTemplate(name) {
  const filePath = path.join(templatesDir, `${name}.mjml`);
  return fs.readFileSync(filePath, "utf8");
}

function compile(templateString, data) {
  const tpl = Handlebars.compile(templateString, { noEscape: true });
  return tpl(data);
}

export function renderEmail(templateName, data = {}) {
  const base = loadTemplate("base");
  const body = loadTemplate(templateName);

  const compiledBody = compile(body, data);
  const merged = compile(base, { ...data, body: compiledBody });

  const { html, errors } = mjml2html(merged, { validationLevel: "soft" });
  if (errors?.length) {
    // eslint-disable-next-line no-console
    console.warn("MJML render warnings:", errors.map((e) => e.formattedMessage));
  }
  return { html };
}
