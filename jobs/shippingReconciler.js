import { bookShipmentFactory } from "../utils/shippingBridge.js";

function safeDate(v) {
  const d = v ? new Date(v) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
}

function minutesAgo(mins) {
  return new Date(Date.now() - mins * 60 * 1000);
}

function normalizeStatus(s) {
  return String(s || "").trim().toLowerCase();
}

export function startShippingReconciler({ Orders, Users, intervalMs = 5 * 60 * 1000 }) {
  console.log("[shipping][reconciler] starting job");
  const bookShipmentFireAndForget = bookShipmentFactory({ Orders, Users });

  const MAX_RETRIES = 10;
  const MIN_GAP_MINUTES = 10;

  async function runOnce() {
    const cutoff = minutesAgo(MIN_GAP_MINUTES);

    const cursor = Orders.find(
      { sellerFulfillment: { $exists: true } },
      { projection: { sellerFulfillment: 1 } }
    ).limit(200);

    let processed = 0;

    while (await cursor.hasNext()) {
      const order = await cursor.next();
      if (!order?._id || !order?.sellerFulfillment) continue;

      const orderId = String(order._id);
      const sf = order.sellerFulfillment;

      for (const sellerIdStr of Object.keys(sf)) {
        const seg = sf?.[sellerIdStr] || {};
        const segStatus = normalizeStatus(seg.status);
        if (segStatus !== "ready_to_ship") {
          console.log(
            "[shipping][reconciler] skipped segment (status)",
            orderId,
            sellerIdStr,
            segStatus || "unknown"
          );
          continue;
        }

        const ship = seg.shipping || {};
        const bookingState = normalizeStatus(ship.bookingState);
        const retryCount = Number(ship.bookingRetryCount || 0);
        const lastAttemptAt = safeDate(ship.lastBookingAttemptAt);

        if (bookingState === "booked") {
          console.log(
            "[shipping][reconciler] skipped segment (already booked)",
            orderId,
            sellerIdStr
          );
          continue;
        }
        if (retryCount >= MAX_RETRIES) {
          console.log(
            "[shipping][reconciler] skipped segment (max retries)",
            orderId,
            sellerIdStr,
            retryCount
          );
          continue;
        }
        if (lastAttemptAt && lastAttemptAt > cutoff) {
          console.log(
            "[shipping][reconciler] skipped segment (min gap)",
            orderId,
            sellerIdStr,
            lastAttemptAt.toISOString()
          );
          continue;
        }

        try {
          bookShipmentFireAndForget({
            orderId,
            sellerId: String(sellerIdStr),
            reason: "reconciler",
          });
          processed += 1;
        } catch (e) {
          console.error(
            "[shipping][reconciler] trigger failed:",
            orderId,
            sellerIdStr,
            e?.message || e
          );
        }
      }
    }

    if (processed) {
      console.log(`[shipping][reconciler] triggered ${processed} booking attempts`);
    }
  }

  const timer = setInterval(() => {
    runOnce().catch((e) =>
      console.error("[shipping][reconciler] runOnce error:", e?.message || e)
    );
  }, intervalMs);

  runOnce().catch(() => {});

  return () => clearInterval(timer);
}
