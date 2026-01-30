import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { connectDb } from "../db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const templatesDir = path.resolve(__dirname, "..", "templates", "emails");

const targets = [
  {
    key: "order_shipped_customer",
    subject: "Your order has shipped",
    previewText: "Your order is on the way. Track it now.",
  },
  {
    key: "return_created_customer",
    subject: "Return request received",
    previewText: "We received your return request.",
  },
  {
    key: "return_request_seller",
    subject: "Return request received",
    previewText: "A return request needs your review.",
  },
];

const db = await connectDb();
const now = new Date();

let published = 0;
let skipped = 0;

for (const target of targets) {
  const filePath = path.join(templatesDir, `${target.key}.mjml`);
  if (!fs.existsSync(filePath)) {
    console.warn(`Template file not found: ${filePath}`);
    skipped += 1;
    continue;
  }

  const mjmlRaw = fs.readFileSync(filePath, "utf-8");

  const latest = await db.collection("emailTemplateVersions")
    .findOne({ templateKey: target.key }, { sort: { version: -1 } });

  const alreadyPublishedSame =
    latest &&
    latest.status === "published" &&
    latest.mjmlRaw === mjmlRaw &&
    latest.subject === target.subject &&
    latest.previewText === target.previewText;

  if (alreadyPublishedSame) {
    skipped += 1;
    continue;
  }

  const nextVersion = (latest?.version || 0) + 1;

  await db.collection("emailTemplateVersions").updateMany(
    { templateKey: target.key, status: "published" },
    { $set: { status: "archived" } }
  );

  await db.collection("emailTemplateVersions").insertOne({
    templateKey: target.key,
    version: nextVersion,
    status: "published",
    subject: target.subject,
    previewText: target.previewText,
    mjmlRaw,
    contentBlocks: null,
    createdBy: "system",
    changeNote: "Targeted publish from repo template",
    createdAt: now,
    publishedAt: now,
  });

  await db.collection("emailTemplates").updateOne(
    { key: target.key },
    { $set: { updatedAt: now } }
  );

  published += 1;
}

console.log(`Published ${published} templates. Skipped ${skipped}.`);
process.exit(0);
