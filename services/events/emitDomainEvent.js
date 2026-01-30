import { client } from "../../dbConfig.js";

const db = client.db(process.env.DB_NAME || "glamzi_ecommerce");
const DomainEvents = db.collection("domainEvents");

export async function emitDomainEvent({
  type,
  actor = { role: "system" },
  refs = {},
  payload = {},
  dedupeKey,
  at = new Date(),
  version = 1,
}) {
  if (!type) throw new Error("Domain event type is required");
  if (!dedupeKey) throw new Error("Domain event dedupeKey is required");

  const now = new Date();
  const doc = {
    type,
    version,
    at,
    actor,
    refs,
    payload,
    dedupeKey,
    status: "pending",
    attempts: 0,
    nextAttemptAt: now,
    lockedAt: null,
    lockId: null,
    processedAt: null,
    failReason: null,
    createdAt: now,
    updatedAt: now,
  };

  try {
    const res = await DomainEvents.insertOne(doc);
    return { ok: true, insertedId: res.insertedId, inserted: true };
  } catch (err) {
    if (err?.code === 11000) {
      const existing = await DomainEvents.findOne(
        { dedupeKey },
        { projection: { _id: 1, status: 1 } }
      );
      return { ok: true, insertedId: existing?._id || null, inserted: false };
    }
    throw err;
  }
}
