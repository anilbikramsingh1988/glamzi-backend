import { client } from "../dbConfig.js";

const db = client.db(process.env.DB_NAME || "glamzi_ecommerce");

async function run() {
  await db.collection("domainEvents").createIndex({ dedupeKey: 1 }, { unique: true });
  await db.collection("domainEvents").createIndex({ status: 1, nextAttemptAt: 1 });
  await db.collection("notificationDeliveries").createIndex({ dedupeKey: 1 }, { unique: true });
  await db.collection("notificationDeliveries").createIndex({ status: 1, createdAt: -1 });
  await db.collection("notificationDeadLetters").createIndex({ createdAt: -1 });
  // eslint-disable-next-line no-console
  console.log("Notification indexes created.");
  process.exit(0);
}

run().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Failed to create notification indexes:", err);
  process.exit(1);
});
