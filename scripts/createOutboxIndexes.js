import { client } from "../dbConfig.js";

const db = client.db(process.env.DB_NAME || "glamzi_ecommerce");
const Outbox = db.collection("outbox");

async function run() {
  await Outbox.createIndex({ status: 1, nextRunAt: 1, createdAt: 1 }, { name: "outbox_status_nextRunAt" });
  await Outbox.createIndex({ createdAt: -1 }, { name: "outbox_createdAt" });
  // eslint-disable-next-line no-console
  console.log("Outbox indexes created.");
  process.exit(0);
}

run().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Failed to create outbox indexes:", err);
  process.exit(1);
});
