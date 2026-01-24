// routes/adminCommissionPayoutRoutes.js
import express from "express";
import dotenv from "dotenv";
import { ObjectId } from "mongodb";

import { client } from "../dbConfig.js";
import {
  authMiddleware,
  isActiveMiddleware,
  isStaffMiddleware,
} from "../middlewares/authMiddleware.js";

dotenv.config();

const router = express.Router();

const dbName = process.env.DB_NAME || "glamzi_ecommerce";
const db = client.db(dbName);

const Invoices = db.collection("invoices");

// Staff guard
const staffGuard = [authMiddleware, isActiveMiddleware, isStaffMiddleware];

// Finance roles allowed
function ensureFinanceRole(req, res) {
  const role = String(req.user?.role || "").toLowerCase();
  const allowed = ["super-admin", "admin", "account"];
  if (!allowed.includes(role)) {
    res.status(403).json({
      success: false,
      message: "Finance access only (super-admin, admin, account).",
    });
    return false;
  }
  return true;
}

function toObjectId(id) {
  try {
    return new ObjectId(id);
  } catch {
    return null;
  }
}

const ALLOWED_PAYOUT_STATUS = ["pending", "paid", "failed"];

/**
 * PATCH /api/admin/commission/:invoiceId/payout-status
 * Body:
 *  {
 *    status: "pending" | "paid" | "failed",
 *    ref?: string,
 *    note?: string,
 *    paidAt?: string (ISO)   // optional; default = now when status=paid
 *  }
 *
 * Updates invoice.commissionPayout.*
 */
router.patch(
  "/commission/:invoiceId/payout-status",
  staffGuard,
  async (req, res) => {
    try {
      if (!ensureFinanceRole(req, res)) return;

      const invoiceId = toObjectId(req.params.invoiceId);
      if (!invoiceId) {
        return res
          .status(400)
          .json({ success: false, message: "Invalid invoiceId" });
      }

      const status = String(req.body?.status || "").toLowerCase().trim();
      const ref = String(req.body?.ref || "").trim();
      const note = String(req.body?.note || "").trim();
      const paidAtRaw = req.body?.paidAt;

      if (!ALLOWED_PAYOUT_STATUS.includes(status)) {
        return res.status(400).json({
          success: false,
          message: `Invalid payout status. Allowed: ${ALLOWED_PAYOUT_STATUS.join(
            ", "
          )}`,
        });
      }

      // Optional: require a reference when paid
      if (status === "paid" && !ref) {
        return res.status(400).json({
          success: false,
          message: "Payout reference (ref) is required when status is paid.",
        });
      }

      let paidAt = null;
      if (status === "paid") {
        if (paidAtRaw) {
          const d = new Date(paidAtRaw);
          paidAt = Number.isNaN(d.getTime()) ? new Date() : d;
        } else {
          paidAt = new Date();
        }
      }

      // Ensure invoice exists
      const invoice = await Invoices.findOne({ _id: invoiceId });
      if (!invoice) {
        return res
          .status(404)
          .json({ success: false, message: "Invoice not found" });
      }

      // Optional guard: only allow payout updates if invoice is issued (or beyond)
      // If you want stricter rules, uncomment:
      // const invStatus = String(invoice.status || "").toLowerCase();
      // if (!["issued", "paid"].includes(invStatus)) {
      //   return res.status(400).json({
      //     success: false,
      //     message: `Cannot set commission payout when invoice status is "${invStatus}".`,
      //   });
      // }

      const now = new Date();
      const adminId = req.user?.id || req.user?._id || null;

      const update = {
        "commissionPayout.status": status,
        "commissionPayout.updatedAt": now,
        "commissionPayout.updatedBy": adminId,
      };

      // ref/note are optional but we set them if provided or if status=paid
      if (ref || status === "paid") update["commissionPayout.ref"] = ref || "";
      if (note) update["commissionPayout.note"] = note;

      // paidAt should be set when paid, and cleared otherwise
      if (status === "paid") update["commissionPayout.paidAt"] = paidAt;
      else update["commissionPayout.paidAt"] = null;

      await Invoices.updateOne(
        { _id: invoiceId },
        { $set: update, $currentDate: { updatedAt: true } }
      );

      const saved = await Invoices.findOne(
        { _id: invoiceId },
        {
          projection: {
            _id: 1,
            sellerId: 1,
            orderId: 1,
            invoiceNumber: 1,
            status: 1,
            commission: 1,
            commissionPayout: 1,
            createdAt: 1,
            updatedAt: 1,
          },
        }
      );

      return res.json({
        success: true,
        message: "Commission payout status updated",
        invoice: saved,
      });
    } catch (err) {
      console.error("PATCH commission payout-status error:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to update commission payout status",
      });
    }
  }
);

/**
 * OPTIONAL: Bulk update payout status (useful for end-of-week settlements)
 * PATCH /api/admin/commission/payout-status/bulk
 * Body:
 *  {
 *    invoiceIds: ["...","..."],
 *    status: "pending"|"paid"|"failed",
 *    ref?: string,
 *    note?: string
 *  }
 */
router.patch(
  "/commission/payout-status/bulk",
  staffGuard,
  async (req, res) => {
    try {
      if (!ensureFinanceRole(req, res)) return;

      const invoiceIdsRaw = req.body?.invoiceIds;
      const status = String(req.body?.status || "").toLowerCase().trim();
      const ref = String(req.body?.ref || "").trim();
      const note = String(req.body?.note || "").trim();

      if (!Array.isArray(invoiceIdsRaw) || invoiceIdsRaw.length === 0) {
        return res
          .status(400)
          .json({ success: false, message: "invoiceIds must be a non-empty array" });
      }
      if (!ALLOWED_PAYOUT_STATUS.includes(status)) {
        return res.status(400).json({
          success: false,
          message: `Invalid payout status. Allowed: ${ALLOWED_PAYOUT_STATUS.join(
            ", "
          )}`,
        });
      }
      if (status === "paid" && !ref) {
        return res.status(400).json({
          success: false,
          message: "Payout reference (ref) is required when status is paid.",
        });
      }

      const ids = invoiceIdsRaw
        .map((id) => toObjectId(id))
        .filter(Boolean);

      if (ids.length === 0) {
        return res
          .status(400)
          .json({ success: false, message: "No valid invoiceIds provided" });
      }

      const now = new Date();
      const adminId = req.user?.id || req.user?._id || null;

      const update = {
        "commissionPayout.status": status,
        "commissionPayout.updatedAt": now,
        "commissionPayout.updatedBy": adminId,
      };

      if (ref || status === "paid") update["commissionPayout.ref"] = ref || "";
      if (note) update["commissionPayout.note"] = note;

      if (status === "paid") update["commissionPayout.paidAt"] = now;
      else update["commissionPayout.paidAt"] = null;

      const result = await Invoices.updateMany(
        { _id: { $in: ids } },
        { $set: update, $currentDate: { updatedAt: true } }
      );

      return res.json({
        success: true,
        message: "Bulk commission payout status updated",
        matched: result.matchedCount,
        modified: result.modifiedCount,
      });
    } catch (err) {
      console.error("PATCH commission payout bulk error:", err);
      return res
        .status(500)
        .json({ success: false, message: "Failed bulk payout update" });
    }
  }
);

export default router;
