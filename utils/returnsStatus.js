// utils/returnsStatus.js

// ----------------------------- statuses -----------------------------

const STATUS_BASE = {
  // Customer initiated
  pending: "pending",

  // Review / approval
  under_review: "under_review",
  approved_awaiting_pickup: "approved_awaiting_pickup",

  // Pickup + transit lifecycle (EverestX / webhook-driven)
  pickup_scheduled: "pickup_scheduled",
  picked_up: "picked_up",
  in_transit: "in_transit",
  out_for_delivery: "out_for_delivery",
  delivered_to_seller: "delivered_to_seller",

  // Seller receives + inspects
  received_by_seller: "received_by_seller",
  inspection_approved: "inspection_approved",
  inspection_rejected: "inspection_rejected",

  // Refund execution & exception handling
  refund_queued: "refund_queued",
  refunded: "refunded",

  // Exceptional / admin tooling / customer cancellation
  rejected: "rejected",
  cancelled_by_customer: "cancelled_by_customer",
  pickup_failed: "pickup_failed",
  pickup_cancelled: "pickup_cancelled",
  disputed: "disputed",
};

const STATUS_UPPER = Object.fromEntries(
  Object.entries(STATUS_BASE).map(([key, value]) => [key.toUpperCase(), value])
);

export const RETURN_STATUS = Object.freeze({
  ...STATUS_BASE,
  ...STATUS_UPPER,
});

// ----------------------------- groups -----------------------------

export const ACTIVE_RETURN_STATUSES = Object.freeze([
  RETURN_STATUS.pending,
  RETURN_STATUS.under_review,
  RETURN_STATUS.approved_awaiting_pickup,
  RETURN_STATUS.pickup_scheduled,
  RETURN_STATUS.pickup_failed,
  RETURN_STATUS.pickup_cancelled,
  RETURN_STATUS.picked_up,
  RETURN_STATUS.in_transit,
  RETURN_STATUS.out_for_delivery,
  RETURN_STATUS.delivered_to_seller,
  RETURN_STATUS.received_by_seller,
  RETURN_STATUS.inspection_approved,
  RETURN_STATUS.inspection_rejected,
  RETURN_STATUS.refund_queued,
  RETURN_STATUS.disputed,
]);

export const TERMINAL_RETURN_STATUSES = Object.freeze([
  RETURN_STATUS.refunded,
  RETURN_STATUS.rejected,
  RETURN_STATUS.cancelled_by_customer,
]);

export function isTerminalReturnStatus(status) {
  return TERMINAL_RETURN_STATUSES.includes(normalizeReturnStatus(status));
}

export function isActiveReturnStatus(status) {
  return ACTIVE_RETURN_STATUSES.includes(normalizeReturnStatus(status));
}

// ----------------------------- normalization -----------------------------

export function normalizeReturnStatus(s) {
  return String(s || "").trim().toLowerCase();
}

function roleOf(actorRole) {
  const r = String(actorRole || "").trim().toLowerCase();
  if (["customer", "seller", "admin", "system"].includes(r)) return r;
  return "system";
}

/**
 * Strict transition matrix with actor-based permissions.
 * - "system" is for webhooks/jobs only.
 * - Webhooks MUST NOT be able to regress or skip.
 */
const TRANSITIONS = Object.freeze({
  [RETURN_STATUS.pending]: {
    customer: [RETURN_STATUS.cancelled_by_customer],
    seller: [RETURN_STATUS.under_review],
    admin: [RETURN_STATUS.under_review],
    system: [RETURN_STATUS.under_review],
  },

  [RETURN_STATUS.under_review]: {
    customer: [RETURN_STATUS.cancelled_by_customer],
    seller: [RETURN_STATUS.approved_awaiting_pickup, RETURN_STATUS.rejected],
    admin: [RETURN_STATUS.approved_awaiting_pickup, RETURN_STATUS.rejected],
    system: [],
  },

  [RETURN_STATUS.approved_awaiting_pickup]: {
    // booking/rescheduling is an admin action, not webhook
    admin: [RETURN_STATUS.pickup_scheduled, RETURN_STATUS.pickup_cancelled],
    seller: [],
    customer: [],
    system: [],
  },

  [RETURN_STATUS.pickup_scheduled]: {
    // webhook-driven shipping events only
    system: [
      RETURN_STATUS.picked_up,
      RETURN_STATUS.pickup_failed, // pickup attempt failed
      RETURN_STATUS.pickup_cancelled, // carrier cancelled
    ],
    admin: [
      // admin can cancel/reschedule as "pickup_cancelled" + new booking metadata
      RETURN_STATUS.pickup_cancelled,
    ],
    seller: [],
    customer: [],
  },

  [RETURN_STATUS.pickup_failed]: {
    // after failure, admin may reschedule (by moving back to pickup_scheduled)
    // NOTE: this is allowed because it does not create a second return doc; it's the same return rebooking.
    admin: [RETURN_STATUS.pickup_scheduled, RETURN_STATUS.pickup_cancelled],
    system: [], // webhook shouldn't "rebook"
    seller: [],
    customer: [],
  },

  [RETURN_STATUS.pickup_cancelled]: {
    // if admin cancels pickup, admin may reschedule again
    admin: [RETURN_STATUS.pickup_scheduled],
    system: [],
    seller: [],
    customer: [],
  },

  [RETURN_STATUS.picked_up]: {
    // after pickup, shipping statuses are webhook-driven
    system: [
      RETURN_STATUS.in_transit,
      RETURN_STATUS.out_for_delivery,
      RETURN_STATUS.delivered_to_seller,
    ],
    admin: [], // admin interventions should be tooling, not status changes
    seller: [],
    customer: [],
  },

  [RETURN_STATUS.in_transit]: {
    system: [RETURN_STATUS.out_for_delivery, RETURN_STATUS.delivered_to_seller],
    admin: [],
    seller: [],
    customer: [],
  },

  [RETURN_STATUS.out_for_delivery]: {
    system: [RETURN_STATUS.delivered_to_seller],
    admin: [],
    seller: [],
    customer: [],
  },

[RETURN_STATUS.delivered_to_seller]: {
  // seller acknowledges physical receipt (manual, not webhook)
  seller: [RETURN_STATUS.received_by_seller],
  admin: [RETURN_STATUS.received_by_seller], // allow admin to assist/override receipt ack
  system: [],
  customer: [],
},

[RETURN_STATUS.received_by_seller]: {
  // seller performs inspection decision
  seller: [RETURN_STATUS.inspection_approved, RETURN_STATUS.inspection_rejected],
  admin: [RETURN_STATUS.inspection_approved, RETURN_STATUS.inspection_rejected], // allow admin tooling
  system: [],
  customer: [],
},

  [RETURN_STATUS.inspection_approved]: {
    // refunds should be executed/admin-controlled (or a system job that admin triggers)
    admin: [RETURN_STATUS.refund_queued],
    system: [], // keep strict: webhook should never mark refund stages
    seller: [],
    customer: [],
  },

  [RETURN_STATUS.refund_queued]: {
    // system job executes refund and marks final
    system: [RETURN_STATUS.refunded],
    admin: [RETURN_STATUS.refunded], // allow manual finalize if payment gateway callback is missing
    seller: [],
    customer: [],
  },

  [RETURN_STATUS.inspection_rejected]: {
    // seller rejected; optional admin escalation to dispute
    customer: [],
    seller: [],
    admin: [RETURN_STATUS.disputed, RETURN_STATUS.rejected],
    system: [],
  },

  [RETURN_STATUS.disputed]: {
    // admin resolves dispute by either approving refund or rejecting/cancelling
    admin: [RETURN_STATUS.refund_queued, RETURN_STATUS.rejected],
    system: [],
    seller: [],
    customer: [],
  },

  // Terminal
  [RETURN_STATUS.refunded]: { customer: [], seller: [], admin: [], system: [] },
  [RETURN_STATUS.rejected]: { customer: [], seller: [], admin: [], system: [] },
  [RETURN_STATUS.cancelled_by_customer]: { customer: [], seller: [], admin: [], system: [] },
});

/**
 * Returns true if actorRole is allowed to move from -> to.
 */
export function canTransitionReturnStatus(from, to, actorRole) {
  const f = normalizeReturnStatus(from);
  const t = normalizeReturnStatus(to);
  const role = roleOf(actorRole);

  // status validity
  if (!Object.values(RETURN_STATUS).includes(f)) return false;
  if (!Object.values(RETURN_STATUS).includes(t)) return false;

  // no transitions out of terminal
  if (TERMINAL_RETURN_STATUSES.includes(f)) return false;

  const allowed = TRANSITIONS?.[f]?.[role] || [];
  return allowed.includes(t);
}
