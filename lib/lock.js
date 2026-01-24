// backend/lib/lock.js (ESM)
import crypto from "crypto";

function now() {
  return new Date();
}

export function makeLockOwner() {
  return `${process.pid}:${crypto.randomUUID()}`;
}

function coerceLeaseMs(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n)) return 10 * 60 * 1000; // 10 min default
  return Math.max(10_000, Math.min(n, 24 * 60 * 60 * 1000)); // 10s..24h
}

/**
 * Acquire a distributed DB lock with a lease.
 *
 * Invariants:
 * - NEVER throws DuplicateKey on contention (we handle it)
 * - Idempotent/re-entrant for same owner
 * - Can take over if expired OR expiresAt is missing OR expiresAt is not a Date (legacy/corrupt)
 *
 * Requires:
 *  db.gl_locks.createIndex({ key: 1 }, { unique: true, name: "uniq_key" })
 *  db.gl_locks.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: "ttl_expiresAt" })
 */
export async function acquireLock({ db, key, owner, runId, leaseMs }) {
  const Locks = db.collection("gl_locks");
  const nowDt = now();
  const lease = coerceLeaseMs(leaseMs);
  const expiresAt = new Date(nowDt.getTime() + lease);

  // Phase 1: Try to take over an existing doc (NO UPSERT → no E11000)
  const takeover = await Locks.findOneAndUpdate(
    {
      key,
      $or: [
        { owner },                          // re-entrant
        { expiresAt: { $lte: nowDt } },      // expired
        { expiresAt: { $exists: false } },   // legacy
        { expiresAt: { $not: { $type: "date" } } }, // corrupted/legacy
        { releasedAt: { $type: "date" } },   // explicitly released
      ],
    },
    {
      $set: {
        owner,
        runId,
        acquiredAt: nowDt,
        updatedAt: nowDt,
        expiresAt,
        releasedAt: null,
      },
      $setOnInsert: {
        // won't apply since upsert=false, but safe to keep out anyway
      },
    },
    { upsert: false, returnDocument: "after" }
  );

  const takeoverDoc = takeover?.value || null;

  if (takeoverDoc && takeoverDoc.owner === owner) {
    return { ok: true, doc: takeoverDoc, mode: "takeover" };
  }

  // Phase 2: No eligible existing lock doc → try insert
  const doc = {
    key,
    owner,
    runId,
    acquiredAt: nowDt,
    updatedAt: nowDt,
    expiresAt,
    releasedAt: null,
    createdAt: nowDt,
  };

  try {
    await Locks.insertOne(doc);
    return { ok: true, doc, mode: "insert" };
  } catch (e) {
    // Contention: another worker inserted first OR existing lock is held and not eligible
    if (e && (e.code === 11000 || e.codeName === "DuplicateKey")) {
      const existing = await Locks.findOne(
        { key },
        { projection: { key: 1, owner: 1, runId: 1, acquiredAt: 1, expiresAt: 1, releasedAt: 1, updatedAt: 1 } }
      );

      return {
        ok: false,
        reason: "LOCK_HELD",
        heldBy: existing?.owner || null,
        heldRunId: existing?.runId || null,
        expiresAt: existing?.expiresAt || null,
        releasedAt: existing?.releasedAt || null,
        updatedAt: existing?.updatedAt || null,
      };
    }
    throw e;
  }
}

export async function releaseLock({ db, key, owner }) {
  const Locks = db.collection("gl_locks");
  const nowDt = now();
  await Locks.updateOne(
    { key, owner },
    {
      $set: {
        releasedAt: nowDt,
        updatedAt: nowDt,
        expiresAt: nowDt, // expire immediately
      },
    }
  );
}
