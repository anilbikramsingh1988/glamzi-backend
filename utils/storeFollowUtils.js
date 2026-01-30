export const FOLLOW_TZ = "Asia/Kathmandu";

export function buildSellerSummaryResponse({
  totalFollowers = 0,
  last7Days = 0,
  last30Days = 0,
  series = [],
} = {}) {
  return {
    totalFollowers: Number(totalFollowers) || 0,
    last7Days: Number(last7Days) || 0,
    last30Days: Number(last30Days) || 0,
    series: Array.isArray(series) ? series : [],
  };
}

export function ensureNoFollowerIdentities(payload) {
  const forbidden = ["customerId", "email", "phone"];
  const json = JSON.stringify(payload || {});
  return forbidden.every((key) => !json.includes(`"${key}"`));
}
