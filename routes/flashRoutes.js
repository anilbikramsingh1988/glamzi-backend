import express from "express";
import dotenv from "dotenv";
import { ObjectId } from "mongodb";
import { client } from "../dbConfig.js";

dotenv.config();
const router = express.Router();

const dbName = process.env.DB_NAME || "glamzi_ecommerce";
const db = client.db(dbName);
const Discounts = db.collection("discounts");
const FlashEntries = db.collection("flashEntries");
const FlashReservations = db.collection("flashReservations");

function toObjectId(id) {
  if (!id) return null;
  try {
    const s = String(id).trim();
    return ObjectId.isValid(s) ? new ObjectId(s) : null;
  } catch {
    return null;
  }
}

// Public: active flash deals
// Returns: { items: [{ _id, title, productIds, pricing, window, limits, status }] }
router.get("/flash-deals", async (req, res) => {
  try {
    const now = new Date();
    const match = {
      saleType: "flash",
      status: "active",
      $or: [{ disabled: { $exists: false } }, { disabled: { $ne: true } }],
      $and: [
        {
          $or: [
            { startAt: null },
            { startAt: { $exists: false } },
            { startAt: { $lte: now } },
          ],
        },
        {
          $or: [
            { endAt: null },
            { endAt: { $exists: false } },
            { endAt: { $gte: now } },
          ],
        },
      ],
    };

    const projection = {
      title: 1,
      productIds: 1,
      pricing: 1,
      window: 1,
      limits: 1,
      status: 1,
      startAt: 1,
      endAt: 1,
    };

    const raw = await Discounts.find(match, { projection })
      .sort({ createdAt: -1 })
      .limit(100)
      .toArray();

    // Pull approved flash entries from sellers and merge productIds per campaign
    const campaignIds = raw.map((d) => d._id).filter(Boolean);
    let entryMap = new Map();
    if (campaignIds.length) {
      const entries = await FlashEntries.find({
        campaignId: { $in: campaignIds },
        status: "approved",
      }).toArray();
      entryMap = new Map();
      entries.forEach((e) => {
        const key = String(e.campaignId);
        if (!entryMap.has(key)) entryMap.set(key, []);
        entryMap.get(key).push(e.productId);
      });
    }

    // Ensure pricing object present (fallback to kind/value)
    const items = raw.map((d) => {
      const extraProducts = entryMap.get(String(d._id)) || [];
      const mergedProducts = Array.from(
        new Set([...(Array.isArray(d.productIds) ? d.productIds : []), ...extraProducts])
      );

      const remaining =
        d?.limits?.totalQty != null
          ? Math.max(0, Number(d.limits.totalQty) - Number(d.reservedQty || 0) - Number(d.soldQty || 0))
          : null;
      const now = new Date();
      const startOk = !d.startAt || new Date(d.startAt) <= now;
      const endOk = !d.endAt || new Date(d.endAt) >= now;
      const active = startOk && endOk && String(d.status || "").toLowerCase() === "active";

      if (d.pricing) return d;
      return {
        ...d,
        productIds: mergedProducts,
        pricing: { type: d.kind || "percentage", value: d.value },
        remainingQty: remaining,
        isActive: active,
      };
    });

    res.json({ success: true, items });
  } catch (err) {
    console.error("GET /api/flash-deals error", err);
    res.status(500).json({ success: false, message: "Failed to load flash deals" });
  }
});

export default router;
