// services/auditLogService.js
import { client } from "../dbConfig.js";
import { ObjectId } from "mongodb";

const db = client.db("glamzi_ecommerce");
const Logs = db.collection("adminLogs");

/**
 * action: string (e.g. "USER_CREATED", "USER_STATUS_CHANGED")
 * actor: { id, email, role }
 * targetUserId: string | ObjectId
 * details: any extra info
 */
export async function logAdminAction({ action, actor, targetUserId, details }) {
  try {
    await Logs.insertOne({
      action,
      actorId: actor?.id ? new ObjectId(actor.id) : null,
      actorEmail: actor?.email || null,
      actorRole: actor?.role || null,
      targetUserId: targetUserId ? new ObjectId(targetUserId) : null,
      details: details || null,
      createdAt: new Date(),
    });
  } catch (err) {
    // Don't crash app for logging failure
    console.error("Audit log error:", err);
  }
}
