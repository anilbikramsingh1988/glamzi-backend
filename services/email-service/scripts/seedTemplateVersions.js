import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { connectDb } from "../db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const templatesDir = path.resolve(__dirname, "..", "templates", "emails");

const SUBJECTS = {
  order_delivered_customer: "Your order was delivered",
  order_cancelled_customer: "Order cancelled",
  return_decision_customer: "Return decision update",
  return_pickup_scheduled_customer: "Return pickup scheduled",
  password_reset_customer: "Reset your password",
  otp_customer: "Your verification code",
  seller_payout_processed: "Payout processed",
  system_alert_admin: "System alert",
};

const PREVIEW = {
  order_delivered_customer: "Your order was delivered. View your order details.",
  order_cancelled_customer: "Your order has been cancelled. Contact support if needed.",
  return_decision_customer: "Your return decision is ready. View details.",
  return_pickup_scheduled_customer: "Your return pickup has been scheduled.",
  password_reset_customer: "Reset your password using the secure link.",
  otp_customer: "Your verification code is inside.",
  seller_payout_processed: "Your payout has been processed. See summary.",
  system_alert_admin: "System alert from Glamzi.",
};

const TEMPLATE_KEYS = Object.keys(SUBJECTS);

export async function seedTemplateVersions() {
  const db = await connectDb();
  const now = new Date();

  let seeded = 0;
  let skipped = 0;

  for (const key of TEMPLATE_KEYS) {
    const filePath = path.join(templatesDir, `${key}.mjml`);
    if (!fs.existsSync(filePath)) {
      console.warn(`Missing template file: ${filePath}`);
      skipped += 1;
      continue;
    }

    const mjmlRaw = fs.readFileSync(filePath, "utf-8");

    const latest = await db
      .collection("emailTemplateVersions")
      .findOne({ templateKey: key }, { sort: { version: -1 } });

    const alreadyPublishedSame =
      latest &&
      latest.status === "published" &&
      latest.mjmlRaw === mjmlRaw &&
      latest.subject === SUBJECTS[key] &&
      latest.previewText === PREVIEW[key];

    if (alreadyPublishedSame) {
      skipped += 1;
      continue;
    }

    const nextVersion = (latest?.version || 0) + 1;

    if (latest && latest.status === "published") {
      await db.collection("emailTemplateVersions").updateMany(
        { templateKey: key, status: "published" },
        { $set: { status: "archived" } }
      );
    }

    await db.collection("emailTemplateVersions").insertOne({
      templateKey: key,
      version: nextVersion,
      status: "published",
      subject: SUBJECTS[key],
      previewText: PREVIEW[key],
      mjmlRaw,
      contentBlocks: null,
      createdBy: "system",
      changeNote: "Seeded from repo templates",
      createdAt: now,
      publishedAt: now,
    });

    await db.collection("emailTemplates").updateOne(
      { key },
      { $set: { updatedAt: now } }
    );

    seeded += 1;
  }

  return { seeded, skipped };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  seedTemplateVersions()
    .then(({ seeded, skipped }) => {
      console.log(`Seeded ${seeded} templates. Skipped ${skipped}.`);
      process.exit(0);
    })
    .catch((err) => {
      console.error("Seed failed:", err);
      process.exit(1);
    });
}
