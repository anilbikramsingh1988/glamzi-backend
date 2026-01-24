// routes/_returnHelpers.js
import { ObjectId } from "mongodb";
import { RETURN_STATUS, TERMINAL_RETURN_STATUSES, canTransitionReturnStatus } from "../utils/returnsStatus.js";

export function toObjectId(id) {
  if (!id) return null;
  if (id instanceof ObjectId) return id;
  try { return new ObjectId(String(id)); } catch { return null; }
}

export function now() {
  return new Date();
}

export function isTerminalStatus(s) {
  return TERMINAL_RETURN_STATUSES.includes(String(s || ""));
}

export function safeStr(v, max = 400) {
  const s = typeof v === "string" ? v.trim() : "";
  if (!s) return null;
  return s.length > max ? s.slice(0, max) : s;
}

export function pushHistory(actor, entry) {
  const at = now();
  return {
    at,
    actor: {
      role: actor?.role || "system",
      userId: actor?.userId || null,
      name: safeStr(actor?.name, 120),
    },
    type: entry.type,
    fromStatus: entry.fromStatus ?? null,
    toStatus: entry.toStatus ?? null,
    message: safeStr(entry.message, 600),
    meta: entry.meta || {},
  };
}

export function actorFromReq(req, fallbackRole = "system") {
  const u = req?.user || {};
  return {
    role: u.role || fallbackRole,
    userId: u._id || null,
    name: u.name || u.fullName || null,
  };
}

/**
 * CAS status update with strict transition enforcement and history append.
 */
export async function casReturnStatus({
  Returns,
  returnId,
  expectedStatus,
  nextStatus,
  actor,
  extraSet = {},
  extraPushHistory = null,
}) {
  if (!canTransitionReturnStatus(expectedStatus, nextStatus, actor.role)) {
    const err = new Error(`Illegal transition ${expectedStatus} -> ${nextStatus} for role ${actor.role}`);
    err.statusCode = 409;
    throw err;
  }

  const update = {
    $set: { status: nextStatus, updatedAt: now(), ...extraSet },
    $inc: { version: 1 },
    $push: {
      history: {
        $each: [
          pushHistory(actor, {
            type: "STATUS_CHANGE",
            fromStatus: expectedStatus,
            toStatus: nextStatus,
            message: extraPushHistory?.message || null,
            meta: extraPushHistory?.meta || {},
          }),
        ],
      },
    },
  };

  // If moving to terminal, close it.
  if (TERMINAL_RETURN_STATUSES.includes(nextStatus)) {
    update.$set.isActive = false;
    update.$set.closedAt = now();
  } else {
    update.$set.isActive = true;
  }

  const res = await Returns.findOneAndUpdate(
    { _id: returnId, status: expectedStatus },
    update,
    { returnDocument: "after" }
  );

  if (!res.value) {
    const current = await Returns.findOne({ _id: returnId });
    if (current?.status === nextStatus) return current;

    const err = new Error("Return not found or status changed (CAS conflict). Refresh and retry.");
    err.statusCode = 409;
    throw err;
  }

  return res.value;
}
