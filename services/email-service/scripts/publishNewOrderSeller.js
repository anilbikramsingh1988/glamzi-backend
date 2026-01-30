import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { connectDb } from "../db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const key = "new_order_seller";
const subject = "New order received";
const previewText = "You have a new order to fulfill.";

const templatesDir = path.resolve(__dirname, "..", "templates", "emails");
const filePath = path.join(templatesDir, `${key}.mjml`);

if (!fs.existsSync(filePath)) {
  console.error(`Template file not found: ${filePath}`);
  process.exit(1);
}

const mjmlRaw = fs.readFileSync(filePath, "utf-8");
const db = await connectDb();
const now = new Date();

const latest = await db.collection("emailTemplateVersions")
  .findOne({ templateKey: key }, { sort: { version: -1 } });

const alreadyPublishedSame =
  latest &&
  latest.status === "published" &&
  latest.mjmlRaw === mjmlRaw &&
  latest.subject === subject &&
  latest.previewText === previewText;

if (alreadyPublishedSame) {
  console.log("Already published latest version; no changes.");
  process.exit(0);
}

const nextVersion = (latest?.version || 0) + 1;

await db.collection("emailTemplateVersions").updateMany(
  { templateKey: key, status: "published" },
  { $set: { status: "archived" } }
);

await db.collection("emailTemplateVersions").insertOne({
  templateKey: key,
  version: nextVersion,
  status: "published",
  subject,
  previewText,
  mjmlRaw,
  contentBlocks: null,
  createdBy: "system",
  changeNote: "Targeted publish from repo template",
  createdAt: now,
  publishedAt: now,
});

await db.collection("emailTemplates").updateOne(
  { key },
  { $set: { updatedAt: now } }
);

console.log(`Published ${key} as version ${nextVersion}.`);
process.exit(0);
