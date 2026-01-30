import assert from "node:assert/strict";
import { buildSellerSummaryResponse, ensureNoFollowerIdentities } from "../utils/storeFollowUtils.js";

const summary = buildSellerSummaryResponse({
  totalFollowers: 42,
  last7Days: 3,
  last30Days: 10,
  series: [
    { dateKey: "2026-01-01", added: 2, lost: 1, net: 1, totalSnapshot: 20 },
  ],
});

assert.equal(summary.totalFollowers, 42);
assert.equal(summary.last7Days, 3);
assert.equal(summary.last30Days, 10);
assert.ok(Array.isArray(summary.series));

assert.equal(
  ensureNoFollowerIdentities(summary),
  true,
  "Seller summary must not include customer identities"
);

console.log("✅ storeFollow privacy tests passed");
