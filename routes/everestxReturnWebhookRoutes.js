// routes/everestxReturnWebhookRoutes.js
import express from "express";
import crypto from "crypto";
import { ObjectId } from "mongodb";
import { client } from "../dbConfig.js";
import { RETURN_STATUS, canTransitionReturnStatus } from "../utils/returnsStatus.js";

const router = express.Router();
const db = client.db(process.env.DB_NAME || "glamzi_ecommerce");

const Returns = db.collection("returns");
const ReturnShipments = db.collection("returnShipments");

/* ----------------------------- helpers ----------------------------- */

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

function parseWebhookTimestamp(body) {
  const candidate =
    body?.timestamp ||
    body?.event?.timestamp ||
    body?.event?.createdAt ||
    body?.createdAt ||
    body?.event?.at ||
    body?.eventTime ||
    null;

  const parsed = candidate ? new Date(candidate) : new Date();
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function boolish(v) {
  if (typeof v === "boolean") return v;
  const s = String(v ?? "").trim().toLowerCase();
  if (!s) return false;
  return ["1", "true", "yes", "y", "on"].includes(s);
}

function normalizePartnerStatus(s) {
  return String(s || "").trim().toUpperCase();
}

function hashEvent({ trackingOrShipment, partnerStatus, ts }) {
  const base = `${trackingOrShipment}|${partnerStatus}|${ts}`;
  return crypto.createHash("sha256").update(base).digest("hex").slice(0, 24);
}

function mapEverestXToReturnStatus(partnerStatusRaw) {
  const s = normalizePartnerStatus(partnerStatusRaw);

  // booking / pickup scheduling
  if (["BOOKED", "CREATED", "PICKUP_SCHEDULED"].includes(s)) return RETURN_STATUS.pickup_scheduled;

  // pickup executed
  if (["PICKED_UP", "PICKEDUP", "COLLECTED"].includes(s)) return RETURN_STATUS.picked_up;

  // transit
  if (["IN_TRANSIT", "ON_ROUTE", "INTRANSIT"].includes(s)) return RETURN_STATUS.in_transit;
  if (["OUT_FOR_DELIVERY", "OFD"].includes(s)) return RETURN_STATUS.out_for_delivery;

  // delivered to seller
  if (["DELIVERED"].includes(s)) return RETURN_STATUS.delivered_to_seller;

  // exceptions
  if (["PICKUP_FAILED", "FAILED"].includes(s)) return RETURN_STATUS.pickup_failed;
  if (["CANCELLED"].includes(s)) return RETURN_STATUS.pickup_cancelled;

  return null;
}

function verifyWebhook(req) {
  const expected = String(process.env.SHIPPING_INTERNAL_TOKEN || "").trim();
  if (!expected) return true;
  const got = String(req.headers["x-internal-token"] || "").trim();
  return !!got && got === expected;
}

// Rank return statuses so we can reject "backwards" updates.
// NOTE: include only the webhook-driven subset (plus pickup_failed/cancelled).
const RETURN_STATUS_RANK = Object.freeze({
  [RETURN_STATUS.pickup_scheduled]: 10,
  [RETURN_STATUS.pickup_failed]: 11, // failure after scheduled
  [RETURN_STATUS.pickup_cancelled]: 12, // cancellation after scheduled
  [RETURN_STATUS.picked_up]: 20,
  [RETURN_STATUS.in_transit]: 30,
  [RETURN_STATUS.out_for_delivery]: 40,
  [RETURN_STATUS.delivered_to_seller]: 50,
});

function rankOf(status) {
  const key = String(status || "").trim().toLowerCase();
  return RETURN_STATUS_RANK[key] ?? 0;
}

function isWebhookAllowed(status) {
  const s = String(status || "").trim().toLowerCase();
  return (
    s === RETURN_STATUS.pickup_scheduled ||
    s === RETURN_STATUS.picked_up ||
    s === RETURN_STATUS.in_transit ||
    s === RETURN_STATUS.out_for_delivery ||
    s === RETURN_STATUS.delivered_to_seller ||
    s === RETURN_STATUS.pickup_failed ||
    s === RETURN_STATUS.pickup_cancelled
  );
}

/* ----------------------------- route ----------------------------- */

router.post("/returns", express.json({ limit: "1mb" }), async (req, res) => {
  try {
    if (!verifyWebhook(req)) return res.status(401).json({ message: "Unauthorized" });

    const trackingNumber = String(
      req.body?.trackingNumber || req.body?.awb || req.body?.waybill || ""
    ).trim();

    const externalShipmentId = String(req.body?.shipmentId || req.body?._id || "").trim();

    const partnerStatusRaw = String(req.body?.status || req.body?.shipmentStatus || "").trim();
    const partnerStatus = normalizePartnerStatus(partnerStatusRaw);

    if (!trackingNumber && !externalShipmentId) {
      return res.status(400).json({ message: "Missing tracking/shipment id" });
    }

    const eventDate = parseWebhookTimestamp(req.body);

    const eventTsString =
      String(req.body?.eventTime || req.body?.timestamp || eventDate.toISOString()).trim() ||
      new Date().toISOString();

    const hashTs = eventTsString.slice(0, 16);
    const providedEventId = String(req.body?.eventId || "").trim();
    const eventId =
      providedEventId ||
      `h:${hashEvent({
        trackingOrShipment: trackingNumber || externalShipmentId,
        partnerStatus,
        ts: hashTs,
      })}`;

    // Find the active booking doc (prefer exact match).
    const ship = await ReturnShipments.findOne({
      partner: "everestx",
      $or: [
        ...(trackingNumber ? [{ trackingNumber }] : []),
        ...(externalShipmentId ? [{ externalShipmentId }] : []),
      ],
    });

    if (!ship) return res.status(404).json({ message: "Return shipment not found" });

    const isReturnFlow =
      boolish(ship.payloadSnapshot?.returnFlow) ||
      boolish(ship.returnFlow) ||
      boolish(req.body?.meta?.returnFlow);

    if (!isReturnFlow) {
      return res.json({ ok: true, ignored: true, reason: "not a returnFlow shipment" });
    }

    // Dedup by eventId (strong).
    const already = await ReturnShipments.findOne(
      { _id: ship._id, "events.eventId": eventId },
      { projection: { _id: 1 } }
    );
    if (already) return res.json({ ok: true, deduped: true, eventId });

    const mapped = mapEverestXToReturnStatus(partnerStatus);

    // Always record event on shipment doc for audit trail.
    await ReturnShipments.updateOne(
      { _id: ship._id },
      {
        $set: {
          updatedAt: now(),
          status: partnerStatus,
          lastWebhookAt: eventDate,
        },
        $push: {
          events: {
            at: eventDate,
            eventId,
            partnerStatus,
            mappedReturnStatus: mapped,
            raw: req.body,
          },
        },
      }
    );

    // If booking is not active, do not mutate Return.
    if (!ship.isActive) {
      return res.json({ ok: true, recordedInactive: true, mapped, eventId });
    }

    if (!mapped) return res.json({ ok: true, mapped: null, eventId });

    if (!isWebhookAllowed(mapped)) {
      return res.json({
        ok: true,
        mapped,
        ignored: true,
        reason: "mapped status not webhook-allowed",
        eventId,
      });
    }

    // Resolve return id safely.
    const retId =
      ship.returnId ? toObjectId(ship.returnId) || ship.returnId : null;

    if (!retId) {
      return res.json({ ok: true, mapped, note: "returnId missing on shipment", eventId });
    }

    const ret = await Returns.findOne({ _id: retId });
    if (!ret) return res.json({ ok: true, mapped, note: "return missing", eventId });

    // Guard against stale/regressive updates:
    // 1) time-based
    const lastAt = ret?.pickup?.lastEventAt ? new Date(ret.pickup.lastEventAt) : null;
    if (lastAt && eventDate < lastAt) {
      return res.json({ ok: true, deduped: true, reason: "stale_event_time", mapped, eventId });
    }

    // 2) rank-based (prevents OFD overwriting DELIVERED when partner timestamps are wonky)
    const currentRank = rankOf(ret.status);
    const incomingRank = rankOf(mapped);
    if (currentRank && incomingRank && incomingRank < currentRank) {
      // Still record lastEventAt to show we received something, but do not regress status.
      await Returns.updateOne(
        { _id: ret._id },
        {
          $set: {
            updatedAt: now(),
            "pickup.lastEventAt": eventDate,
            "pickup.partner": "everestx",
            "pickup.partnerStatus": partnerStatus,
          },
        }
      );
      return res.json({
        ok: true,
        ignored: true,
        reason: `regressive_status_rank ${ret.status}(${currentRank}) -> ${mapped}(${incomingRank})`,
        mapped,
        eventId,
      });
    }

    // Idempotent if already at that status.
    if (String(ret.status || "").trim().toLowerCase() === String(mapped || "").trim().toLowerCase()) {
      await Returns.updateOne(
        { _id: ret._id },
        {
          $set: {
            updatedAt: now(),
            "pickup.lastEventAt": eventDate,
            "pickup.partner": "everestx",
            "pickup.partnerStatus": partnerStatus,
            ...(trackingNumber ? { "pickup.latestTrackingNumber": trackingNumber } : {}),
            ...(externalShipmentId ? { "pickup.latestExternalShipmentId": externalShipmentId } : {}),
          },
        }
      );
      return res.json({ ok: true, mapped, idempotent: true, eventId });
    }

    // Strict transition check: webhooks are "system"
    const allowed = canTransitionReturnStatus(ret.status, mapped, "system");
    if (!allowed) {
      return res.json({
        ok: true,
        mapped,
        ignored: true,
        reason: `cannot transition ${ret.status} -> ${mapped} as system`,
        eventId,
      });
    }

    const set = {
      status: mapped,
      statusUpdatedAt: eventDate,
      updatedAt: now(),

      // pickup metadata for UI + debugging
      "pickup.lastEventAt": eventDate,
      "pickup.partner": "everestx",
      "pickup.partnerStatus": partnerStatus,
      "pickup.activeBookingId": ship._id, // important for traceability
      ...(trackingNumber ? { "pickup.latestTrackingNumber": trackingNumber } : {}),
      ...(externalShipmentId ? { "pickup.latestExternalShipmentId": externalShipmentId } : {}),
    };

    // Start inspection SLA once delivered to seller (based on eventDate, not server time).
    if (mapped === RETURN_STATUS.delivered_to_seller) {
      const hours = Number(process.env.RETURN_INSPECTION_SLA_HOURS || 72);
      const due = new Date(eventDate.getTime() + hours * 60 * 60 * 1000);
      set["sla.inspectDueAt"] = due;
    }

    await Returns.updateOne(
      { _id: ret._id },
      {
        $set: set,
        $push: {
          events: {
            at: eventDate,
            actor: { role: "system", id: "everestx_webhook" },
            type: "EVERESTX_STATUS",
            meta: { partnerStatus, mapped, eventId },
          },
        },
      }
    );

    return res.json({ ok: true, mapped, eventId });
  } catch (err) {
    console.error("POST /returns webhook error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

export default router;
