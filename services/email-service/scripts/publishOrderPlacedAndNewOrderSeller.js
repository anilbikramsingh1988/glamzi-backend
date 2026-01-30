import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { connectDb } from "../db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const templatesDir = path.resolve(__dirname, "..", "templates", "emails");

const targets = [
  {
    key: "order_placed_customer",
    subject: "Order Confirmed",
    previewText: "Your order is confirmed and being prepared.",
  },
  {
    key: "new_order_seller",
    subject: "New order received",
    previewText: "You have a new order to fulfill.",
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
