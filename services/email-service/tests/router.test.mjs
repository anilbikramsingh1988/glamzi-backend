import assert from "node:assert/strict";
import { resolveRouting, shouldRespectQuietHours } from "../services/routing/emailRouter.js";

const settings = {
  fromProfiles: {
    orders: { fromEmail: "orders@glamzibeauty.com", fromName: "Glamzi Orders" },
    "no-reply": { fromEmail: "no-reply@glamzibeauty.com", fromName: "Glamzi" },
  },
};

const job = { type: "order.placed.customer" };
const routing = resolveRouting(job, settings);
assert.equal(routing.fromKey, "orders");
assert.equal(routing.from.email, "orders@glamzibeauty.com");

assert.equal(shouldRespectQuietHours("marketing.newsletter"), true);
assert.equal(shouldRespectQuietHours("order.placed"), false);

console.log("router tests passed");
