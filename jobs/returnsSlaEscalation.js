import { getDB } from "../dbConfig.js";
import { RETURN_STATUS } from "../utils/returnsStatus.js";

function now() {
  return new Date();
}

async function getReturnsCollection() {
  const db = await getDB();
  return db.collection("returns");
}

export async function runReturnsSlaEscalation({ limit = 200 } = {}) {
  const Returns = await getReturnsCollection();
  const ts = now();

  const cursor = Returns.find(
    {
      status: { $in: [RETURN_STATUS.DELIVERED_TO_SELLER, RETURN_STATUS.RECEIVED_BY_SELLER] },
      "sla.inspectDueAt": { $exists: true, $type: "date", $lt: ts },
    },
    { sort: { "sla.inspectDueAt": 1 }, limit }
  );

  let count = 0;
  while (await cursor.hasNext()) {
    const ret = await cursor.next();
    const currentLevel = Number(ret.sla?.escalationLevel || 0);
    const nextLevel = Math.min(currentLevel + 1, 3);

    const lastEsc = ret.sla?.lastEscalatedAt ? new Date(ret.sla.lastEscalatedAt) : null;
    if (lastEsc && ts.getTime() - lastEsc.getTime() < 20 * 60 * 60 * 1000) continue;

    await Returns.updateOne(
      { _id: ret._id },
      {
        $set: { "sla.escalationLevel": nextLevel, "sla.lastEscalatedAt": ts, updatedAt: ts },
        $push: {
          events: {
            at: ts,
            actor: { kind: "system", id: "sla_job" },
            type: "SLA_ESCALATED",
            meta: { from: currentLevel, to: nextLevel, dueAt: ret.sla?.inspectDueAt },
          },
        },
      }
    );

    count += 1;
  }

  return { escalated: count };
}
