import express from "express";
import crypto from "crypto";
import { ObjectId } from "mongodb";
import { RETURN_STATUS, canTransitionReturnStatus } from "../utils/returnsStatus.js";

/* ===============================
   ENV / TOKEN
=============================== */

const INTERNAL_TOKEN = String(
  process.env.SHIPPING_INTERNAL_TOKEN || process.env.SHIPPING_INTERNAL_SECRET || ""
).trim();

function safeStr(v, max = 400) {
  const s = typeof v === "string" ? v.trim() : "";
  if (!s) return null;
  return s.length > max ? s.slice(0, max) : s;
}

function normalizeStatus(s) {
  return String(s || "").trim().toLowerCase();
}

function normalizePartner(p) {
  // partner is not a "status" semantically, but we want consistent lowercase storage
  return normalizeStatus(p || "");
}

function mapShipmentStatusToReturnStatus(status) {
  const s = normalizeStatus(status);
  if (!s) return null;
  if (["booked", "scheduled", "pickup_scheduled"].includes(s)) {
    return RETURN_STATUS.PICKUP_SCHEDULED;
  }
  if (["picked_up", "pickedup", "collected", "pickup_collected"].includes(s)) {
    return RETURN_STATUS.PICKED_UP;
  }
  if (["arrived_hub", "arrived", "hub_arrived", "received_hub", "hub_received"].includes(s)) {
    return RETURN_STATUS.RECEIVED_AT_HUB;
  }
  return null;
}

const EVERSTX_RETURN_STATUSES = [
  RETURN_STATUS.PICKED_UP,
  RETURN_STATUS.RECEIVED_AT_HUB,
];

function requireInternalToken(req) {
  // Header key you already use in glamziClient.js
  const incoming = String(req.headers["x-internal-token"] || "").trim();

  // In production, require token
  if (process.env.NODE_ENV === "production") {
    if (!INTERNAL_TOKEN) return false;
    if (!incoming) return false;
  }

  // If no token configured (dev), allow
  if (!INTERNAL_TOKEN) return true;

  // Constant-time compare when possible
  try {
    const a = Buffer.from(incoming);
    const b = Buffer.from(INTERNAL_TOKEN);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return incoming === INTERNAL_TOKEN;
  }
}

/* ===============================
   STATUS MAPPING
=============================== */

// Map shipping partner statuses → Glamzi internal seller segment status
function mapToSellerStatus(shipmentStatus) {
  const s = normalizeStatus(shipmentStatus);

  // partner variations
  if (["delivered", "delivered_success", "completed"].includes(s)) return "delivered";
  if (["shipped", "out_for_delivery", "ofd", "on_route", "in_transit"].includes(s)) return "shipped";
  if (["picked_up", "pickedup", "collected"].includes(s)) return "processing";
  if (["failed", "undelivered", "delivery_failed", "rto", "return_to_origin"].includes(s)) return "failed";
  if (["cancelled", "canceled"].includes(s)) return "cancelled";

  // default
  return "shipped";
}

function statusRank(s) {
  // Used only to prevent regressions
  const v = normalizeStatus(s);
  const m = {
    created: 10,
    confirmed: 20,
    processing: 30,
    ready_to_ship: 40,
    shipped: 50,
    delivered: 60,
    completed: 70,
    failed: 90,
    cancelled: 95,
  };
  return m[v] || 0;
}

function isCodOrder(order) {
  const pm = String(order?.paymentMethod || order?.payment?.method || "").toLowerCase();
  const codFlag =
    order?.isCOD === true ||
    order?.cod === true ||
    pm === "cod" ||
    pm === "cash_on_delivery";
  return codFlag;
}

function isCodSettled(order) {
  const ps = String(order?.paymentStatus || order?.payment?.status || "").toLowerCase();
  return ["settled", "verified", "paid"].includes(ps);
}

function deriveOverallOrderStatusFromSellerFulfillment(sf, order) {
  const entries = Object.values(sf || {});
  if (!entries.length) return null;

  const anyBad = entries.some((x) => ["failed", "cancelled"].includes(normalizeStatus(x?.status)));
  if (anyBad) return null;

  const allDeliveredOrCompleted = entries.every((x) =>
    ["delivered", "completed"].includes(normalizeStatus(x?.status))
  );

  if (allDeliveredOrCompleted) {
    if (isCodOrder(order)) {
      return isCodSettled(order) ? "completed" : "delivered";
    }
    return "completed";
  }

  const anyShipped = entries.some((x) => ["shipped"].includes(normalizeStatus(x?.status)));
  if (anyShipped) return "shipped";

  return null;
}

/* ===============================
   FACTORY
=============================== */

export default function shippingCallbackRoutesFactory({ Orders, Invoices }) {
  const router = express.Router();

  /**
   * POST /api/shipping/status-callback
   * Body:
   * {
   *   eventId, orderId, sellerId, status, externalStatus?, trackingNumber,
   *   partner?, timestamp?, source?
   * }
   */
  router.post("/status-callback", async (req, res) => {
    try {
      if (!requireInternalToken(req)) {
        console.warn("[shipping-callback] Invalid internal token");
        return res.status(401).json({ ok: false, error: "Unauthorized" });
      }

      const body = req.body || {};
      if (process.env.NODE_ENV !== "production") {
        console.log("[shipping-callback] payload", {
          eventId: body?.eventId,
          orderId: body?.orderId,
          sellerId: body?.sellerId,
          status: body?.status,
          externalStatus: body?.externalStatus,
          trackingNumber: body?.trackingNumber,
          partner: body?.partner,
          timestamp: body?.timestamp,
          source: body?.source,
        });
      }

      // ✅ idempotency key from glamziClient.js
      const eventId = safeStr(body.eventId, 220);

      let orderId = body.orderId;
      const sellerId = String(body.sellerId || "").trim();

      // partner status (normalized)
      const partnerStatus = normalizeStatus(body.status);

      const externalStatus = safeStr(body.externalStatus, 120);
      const trackingNumber = safeStr(body.trackingNumber, 120);

      // ✅ enforce lower partner string
      const partner = normalizePartner(safeStr(body.partner, 60) || "everestx");

      // ✅ enforce lower source string
      const source = normalizeStatus(safeStr(body.source, 60) || "everestx");

      const ts = body.timestamp ? new Date(body.timestamp) : new Date();
      const at = Number.isNaN(ts.getTime()) ? new Date() : ts;

      // Fallback: if orderId is missing/invalid but we have sellerId + trackingNumber,
      // try to locate the order segment by trackingNumber for that seller.
      let order = null;
      if (!ObjectId.isValid(orderId)) {
        if (sellerId && trackingNumber) {
          const shippingPath = `sellerFulfillment.${sellerId}.shipping`;
          order = await Orders.findOne({
            $or: [
              { [`${shippingPath}.trackingNumber`]: trackingNumber },
              { [`${shippingPath}.trackingNumberLatest`]: trackingNumber },
            ],
          });
          if (order?._id) {
            orderId = order._id.toString();
          }
        }
      }

      if (!order && ObjectId.isValid(orderId) && sellerId && trackingNumber) {
        const orderObjectId = new ObjectId(orderId);
        order = await Orders.findOne({ _id: orderObjectId });
      }

      if (!orderId || !ObjectId.isValid(orderId) || !sellerId || !trackingNumber || !order) {
        return res
          .status(400)
          .json({ ok: false, error: "Missing orderId/sellerId/trackingNumber" });
      }

      if (!order) {
        console.warn("[shipping-callback] Order not found:", orderId);
        return res.json({ ok: true, ignored: true });
      }

      const seg = order?.sellerFulfillment?.[sellerId] || null;
      if (!seg) {
        console.warn("[shipping-callback] Seller segment missing:", orderId, sellerId);
        return res.json({ ok: true, ignored: true });
      }

      const sellerPath = `sellerFulfillment.${sellerId}`;
      const shippingPath = `${sellerPath}.shipping`;

      // ✅ normalize shipmentStatus always lowercase
      const internalShipmentStatus = normalizeStatus(partnerStatus || "in_transit");
      const nextSellerStatus = mapToSellerStatus(internalShipmentStatus);
      const shouldAutoCompleteCod =
        internalShipmentStatus === "completed" && isCodOrder(order);

      // Regression guard for sellerFulfillment status:
      const currentSellerStatus = normalizeStatus(seg?.status || "");
      const allow =
        !currentSellerStatus ||
        statusRank(nextSellerStatus) >= statusRank(currentSellerStatus);

      // Build next sellerFulfillment map in-memory to compute overall safely
      const nextSellerFulfillment = {
        ...(order.sellerFulfillment || {}),
        [sellerId]: {
          ...(seg || {}),
          ...(allow ? { status: nextSellerStatus, updatedAt: new Date() } : {}),
        },
      };

      const nextOverall = deriveOverallOrderStatusFromSellerFulfillment(nextSellerFulfillment, order);

      // ✅ Idempotency filter (prevents duplicate event processing)
      // If eventId present, only apply if lastEventId != eventId
      const idempotencyFilter = eventId
        ? { [`${shippingPath}.lastEventId`]: { $ne: eventId } }
        : {};

      const setPatch = {
        // Shipping fields
        [`${shippingPath}.partner`]: partner,
        ...(seg?.shipping?.trackingNumber
          ? {}
          : { [`${shippingPath}.trackingNumber`]: trackingNumber }),
        [`${shippingPath}.shipmentStatus`]: internalShipmentStatus,
        [`${shippingPath}.externalStatus`]: externalStatus,
        [`${shippingPath}.lastStatusAt`]: at,
        [`${shippingPath}.updatedAt`]: new Date(),
        [`${shippingPath}.source`]: source,
        ...(eventId ? { [`${shippingPath}.lastEventId`]: eventId } : {}),

        // seller segment status update (only if not regressing)
        ...(allow ? { [`${sellerPath}.status`]: nextSellerStatus } : {}),

        // overall order status (only when we can confidently derive it)
        ...(nextOverall ? { status: nextOverall } : {}),

        updatedAt: new Date(),
      };

      const hasReturnRecord = Boolean(order?.returnAdmin || order?.returnRequest);
      if (hasReturnRecord && trackingNumber) {
        const pickupPath = "returnAdmin.pickup";
        const existingPickup = order?.returnAdmin?.pickup || {};
        if (!existingPickup.trackingNumber) {
          setPatch[`${pickupPath}.trackingNumber`] = trackingNumber;
        }
        setPatch[`${pickupPath}.trackingNumberLatest`] = trackingNumber;
      }

      if (hasReturnRecord) {
        const returnRecord = order.returnRequest || {};
        const currentReturnStatus = normalizeStatus(
          returnRecord.status || RETURN_STATUS.PENDING
        );
        const returnActor = source || partner || "shipping-webhook";
        const nextReturnStatus = mapShipmentStatusToReturnStatus(internalShipmentStatus);
        if (
          nextReturnStatus &&
          canTransitionReturnStatus(currentReturnStatus, nextReturnStatus, "shipping")
        ) {
          setPatch["returnRequest.status"] = nextReturnStatus;
          setPatch["returnRequest.updatedAt"] = at;
          setPatch["returnAdmin.status"] = nextReturnStatus;

          const normalizedPartner = normalizePartner(partner);
          const normalizedSource = normalizeStatus(source);
          const isEverestXPartner =
            normalizedPartner === "everestx" || normalizedSource === "everestx";
          const isEverestXReturnStatus = EVERSTX_RETURN_STATUSES.includes(
            nextReturnStatus
          );
          if (isEverestXPartner && isEverestXReturnStatus) {
            setPatch["returnAdmin.source"] =
              normalizedPartner || normalizedSource || "everestx";
            setPatch["returnAdmin.everestX"] = true;
            setPatch["returnAdmin.everestXStatus"] = nextReturnStatus;
            setPatch["returnAdmin.everestXUpdatedAt"] = at;
            setPatch["returnRequest.everestX"] = true;
            setPatch["returnRequest.everestXStatus"] = nextReturnStatus;
          }

          const historyEntry = {
            status: nextReturnStatus,
            at,
            actor: returnActor,
            note: `${internalShipmentStatus} via ${partner}`,
          };
          pushPatch["returnRequest.history"] = historyEntry;
        }
      }

      if (shouldAutoCompleteCod) {
        setPatch.status = "completed";
        setPatch.completedAt = at;
        setPatch.paymentStatus = "paid";
        setPatch.paidAt = at;
        setPatch["payment.status"] = "paid";
        setPatch["payment.paidAt"] = at;
        setPatch[`${sellerPath}.status`] = "completed";
        setPatch[`${sellerPath}.completedAt`] = at;
        setPatch[`${sellerPath}.paymentStatus`] = "settled";
        setPatch[`${sellerPath}.codSettledAt`] = at;
      }

      const pushPatch = {
        [`${shippingPath}.events`]: {
          at,
          status: internalShipmentStatus, // ✅ always lowercase
          externalStatus: externalStatus ? String(externalStatus).toLowerCase() : null,
          trackingNumber,
          partner,
          source,
          eventId: eventId || null,
          type: "STATUS_CALLBACK",
        },
      };

      // ✅ Optional per-segment timeline array (your code already uses arrays on sellerPath.timeline)
      // Only push timeline when we actually applied something meaningful.
      const shouldPushTimeline = allow || !!nextOverall;
      if (shouldPushTimeline) {
        const timelineEvent = {
          at: new Date(),
          action: "SHIPPING_STATUS",
          partner,
          trackingNumber,
          shipmentStatus: internalShipmentStatus,
          sellerStatusApplied: allow ? nextSellerStatus : null,
          orderStatusApplied: nextOverall || null,
          eventId: eventId || null,
          source: "shipping-callback",
        };

        if (Array.isArray(seg?.timeline)) {
          pushPatch[`${sellerPath}.timeline`] = timelineEvent;
        } else {
          setPatch[`${sellerPath}.timeline`] = [timelineEvent];
        }
      }

      const upd = await Orders.updateOne(
        { _id: orderObjectId, ...idempotencyFilter },
        {
          $set: setPatch,
          $push: pushPatch,
        }
      );

      // If idempotency prevented update, treat as duplicate (ok)
      if (eventId && upd?.matchedCount === 0) {
        return res.json({
          ok: true,
          duplicate: true,
          applied: null,
          reason: "eventId_already_processed",
        });
      }

      if (shouldAutoCompleteCod && Invoices) {
        const latestCodInvoice = await Invoices.findOne(
          {
            $and: [
              {
                $or: [
                  { orderId: orderObjectId },
                  { orderId: String(orderId) },
                  { orderId: { $eq: String(orderId) } },
                ],
              },
              { paymentMethod: { $regex: /^cod$/i } },
            ],
          },
          { sort: { createdAt: -1, _id: -1 } }
        );

        if (latestCodInvoice && String(latestCodInvoice.status || "").toLowerCase() !== "paid") {
          const invPatch = {
            status: "paid",
            paymentStatus: "paid",
            paidAt: at,
            updatedAt: new Date(),
          };
          if (!latestCodInvoice.paymentReference && eventId) {
            invPatch.paymentReference = eventId;
          }

          await Invoices.updateOne({ _id: latestCodInvoice._id }, { $set: invPatch });
        }
      }

      return res.json({
        ok: true,
        applied: {
          shipmentStatus: internalShipmentStatus,
          sellerStatus: allow ? nextSellerStatus : null,
          orderStatus: nextOverall || null,
          eventId: eventId || null,
        },
        skipped: allow ? null : "seller_status_regression_blocked",
      });
    } catch (e) {
      console.error("[shipping][callback] error:", e?.message || e);
      return res.status(500).json({ ok: false, error: "Internal server error" });
    }
  });

  /**
   * POST /api/shipping/cod-settled-callback
   * Body:
   * { eventId, orderId, sellerId, trackingNumber?, partner?, timestamp?, source? }
   */
  router.post("/cod-settled-callback", async (req, res) => {
    try {
      if (!requireInternalToken(req)) {
        console.warn("[shipping-callback] Invalid internal token (cod-settled)");
        return res.status(401).json({ ok: false, error: "Unauthorized" });
      }

      const body = req.body || {};

      const eventId = safeStr(body.eventId, 220);

      const orderId = body.orderId;
      const sellerId = String(body.sellerId || "").trim();

      const trackingNumber = safeStr(body.trackingNumber, 120);
      const partner = normalizePartner(safeStr(body.partner, 60) || "everestx");
      const source = normalizeStatus(safeStr(body.source, 60) || "everestx");

      const ts = body.timestamp ? new Date(body.timestamp) : new Date();
      const at = Number.isNaN(ts.getTime()) ? new Date() : ts;

      if (!ObjectId.isValid(orderId) || !sellerId) {
        return res.status(400).json({ ok: false, error: "Missing orderId/sellerId" });
      }

      const orderObjectId = new ObjectId(orderId);
      const order = await Orders.findOne({ _id: orderObjectId });
      if (!order) return res.json({ ok: true, ignored: true });

      const seg = order?.sellerFulfillment?.[sellerId] || null;
      if (!seg) return res.json({ ok: true, ignored: true });

      const sellerPath = `sellerFulfillment.${sellerId}`;
      const shippingPath = `${sellerPath}.shipping`;

      // ✅ idempotency: do not re-apply same COD settled event
      const idempotencyFilter = eventId
        ? { [`${sellerPath}.codLastEventId`]: { $ne: eventId } }
        : {};

      const segStatus = normalizeStatus(seg?.status);
      const isDelivered = segStatus === "delivered";
      const isAlreadyCompleted = segStatus === "completed";

      const setPatch = {
        [`${sellerPath}.paymentStatus`]: "settled",
        [`${sellerPath}.codSettledAt`]: at,
        [`${sellerPath}.codPartner`]: partner,
        ...(eventId ? { [`${sellerPath}.codLastEventId`]: eventId } : {}),
        paymentStatus: "paid",
        paidAt: at,
        "payment.status": "paid",
        "payment.paidAt": at,
        updatedAt: new Date(),
      };

      if (isDelivered) {
        setPatch[`${sellerPath}.status`] = "completed";
        setPatch[`${sellerPath}.completedAt`] = at;
      }

      const timelineEvent = {
        at,
        action: "COD_SETTLED",
        partner,
        trackingNumber: trackingNumber || null,
        eventId: eventId || null,
        source: "shipping-callback",
      };

      const pushPatch = {};
      if (Array.isArray(seg?.timeline)) {
        pushPatch[`${sellerPath}.timeline`] = timelineEvent;
      } else {
        setPatch[`${sellerPath}.timeline`] = [timelineEvent];
      }

      // Optionally annotate shipping path too (consistent)
      if (eventId) {
        setPatch[`${shippingPath}.lastCodEventId`] = eventId;
        setPatch[`${shippingPath}.codSettledAt`] = at;
        setPatch[`${shippingPath}.codPartner`] = partner;
        setPatch[`${shippingPath}.codSource`] = source;
      }

      const updateDoc = { $set: setPatch };
      if (Object.keys(pushPatch).length) updateDoc.$push = pushPatch;

      const upd = await Orders.updateOne(
        { _id: orderObjectId, ...idempotencyFilter },
        updateDoc
      );

      if (eventId && upd?.matchedCount === 0) {
        return res.json({
          ok: true,
          duplicate: true,
          reason: "cod_eventId_already_processed",
        });
      }

      if (Invoices) {
        const latestCodInvoice = await Invoices.findOne(
          {
            $and: [
              {
                $or: [
                  { orderId: orderObjectId },
                  { orderId: String(orderId) },
                  { orderId: { $eq: String(orderId) } },
                ],
              },
              { paymentMethod: { $regex: /^cod$/i } },
            ],
          },
          { sort: { createdAt: -1, _id: -1 } }
        );

        if (latestCodInvoice && String(latestCodInvoice.status || "").toLowerCase() !== "paid") {
          const invPatch = {
            status: "paid",
            paymentStatus: "paid",
            paidAt: at,
            updatedAt: new Date(),
          };
          if (!latestCodInvoice.paymentReference && eventId) {
            invPatch.paymentReference = eventId;
          }

          await Invoices.updateOne({ _id: latestCodInvoice._id }, { $set: invPatch });
        }
      }

      // Re-check if all segments are delivered/completed -> mark order complete (COD-safe)
      const fresh = await Orders.findOne(
        { _id: orderObjectId },
        { projection: { sellerFulfillment: 1, status: 1, paymentMethod: 1, paymentStatus: 1 } }
      );

      const sf = fresh?.sellerFulfillment || {};
      const allDone = Object.values(sf).length
        ? Object.values(sf).every((x) =>
            ["delivered", "completed"].includes(normalizeStatus(x?.status))
          )
        : false;

      if (allDone) {
        await Orders.updateOne(
          { _id: orderObjectId, status: { $ne: "completed" } },
          { $set: { status: "completed", completedAt: at, updatedAt: new Date() } }
        );
      }

      return res.json({
        ok: true,
        promoted: isDelivered && !isAlreadyCompleted,
        orderCompleted: allDone,
        eventId: eventId || null,
      });
    } catch (e) {
      console.error("[shipping][cod-settled-callback] error:", e?.message || e);
      return res.status(500).json({ ok: false, error: "Internal server error" });
    }
  });

  return router;
}
