import { client } from "../dbConfig.js";

const db = client.db(process.env.DB_NAME || "glamzi_ecommerce");
const Outbox = db.collection("outbox");

export async function enqueueEvent({ type, payload = {}, runAt = null }) {
  if (!type) throw new Error("Outbox event type is required");
  const now = new Date();
  const doc = {
    type,
    payload,
    status: "pending",
    attempts: 0,
    nextRunAt: runAt || now,
    lockedAt: null,
    lockedBy: null,
    lastError: null,
    createdAt: now,
    updatedAt: now,
  };
  const res = await Outbox.insertOne(doc);
  return res.insertedId;
}

export async function enqueueNotification(target, data) {
  if (!target) throw new Error("Notification target is required");
  return enqueueEvent({
    type: `notify.${target}`,
    payload: data || {},
  });
}
