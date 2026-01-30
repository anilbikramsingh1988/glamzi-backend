import dotenv from "dotenv";
import { connectDb } from "../db.js";

dotenv.config();

async function run() {
  const db = await connectDb();

  await db.collection("emailJobs").createIndex({ idempotencyKey: 1 }, { unique: true });
  await db.collection("emailJobs").createIndex({ status: 1, nextAttemptAt: 1, priorityRank: 1 });
  await db.collection("emailJobs").createIndex({ type: 1, createdAt: -1 });

  await db.collection("emailDeadLetters").createIndex({ createdAt: -1 });

  console.log("Indexes created");
  process.exit(0);
}

run().catch((err) => {
  console.error("Index creation failed:", err);
  process.exit(1);
});
