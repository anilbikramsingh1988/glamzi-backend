import express from "express";
import { ObjectId } from "mongodb";
import { client } from "../dbConfig.js";
import { authMiddleware } from "../middlewares/authMiddleware.js";
import { isStaffMiddleware, ensureAdminRole } from "../middlewares/staffGuard.js";
import { RETURN_STATUS, canTransitionReturnStatus } from "../utils/returnsStatus.js";

const router = express.Router();
const db = client.db(process.env.DB_NAME || "glamzi_ecommerce");

const Refunds = db.collection("refunds");
const Returns = db.collection("returns");

function toObjectId(id) {
  try {
    return new ObjectId(String(id));
  } catch {
    return null;
  }
}

function now() {
  return new Date();
}

router.patch("/:refundId/mark-succeeded", authMiddleware, isStaffMiddleware, ensureAdminRole("finance"), async (req, res) => {
  const fid = toObjectId(req.params.refundId);
  if (!fid) return res.status(400).json({ message: "Invalid refund id" });

  const actorId = String(req.user?._id || "");

  const session = client.startSession();
  try {
    let out;
    await session.withTransaction(async () => {
      const refund = await Refunds.findOne({ _id: fid }, { session });
      if (!refund) throw new Error("REFUND_NOT_FOUND");
      if (refund.status === "succeeded") {
        out = { idempotent: true, refund };
        return;
      }

      await Refunds.updateOne(
        { _id: fid, status: { $in: ["queued", "processing", "failed"] } },
        {
          $set: {
            status: "succeeded",
            updatedAt: now(),
            "provider.reference": String(req.body?.providerRef || refund.provider?.reference || ""),
            "provider.raw": req.body?.providerRaw || refund.provider?.raw || null,
          },
        },
        { session }
      );

      const ret = await Returns.findOne({ _id: refund.returnId }, { session });
      if (ret) {
        if (ret.status !== RETURN_STATUS.REFUND_QUEUED) throw new Error(`RETURN_NOT_REFUND_QUEUED:${ret.status}`);
        if (!canTransitionReturnStatus(ret.status, RETURN_STATUS.REFUNDED)) throw new Error("CANNOT_TRANSITION_TO_REFUNDED");

        await Returns.updateOne(
          { _id: ret._id, status: RETURN_STATUS.REFUND_QUEUED },
          {
            $set: { status: RETURN_STATUS.REFUNDED, statusUpdatedAt: now(), updatedAt: now() },
            $push: {
              events: {
                at: now(),
                actor: { kind: "finance", id: actorId },
                type: "REFUND_SUCCEEDED",
                meta: { refundId: String(fid) },
              },
            },
          },
          { session }
        );
      }

      out = { idempotent: false };
    });

    return res.json({ ok: true, ...out });
  } catch (e) {
    const msg = String(e?.message || e);
    if (msg === "REFUND_NOT_FOUND") return res.status(404).json({ message: "Refund not found" });
    if (msg.startsWith("RETURN_NOT_REFUND_QUEUED:")) return res.status(409).json({ message: msg });
    return res.status(400).json({ message: "Mark succeeded failed", error: msg });
  } finally {
    await session.endSession();
  }
});

export default router;
