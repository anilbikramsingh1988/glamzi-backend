// backend/lib/dailyClose.js (ESM)

/**
 * Compute daily close strictly from gl_ledger_entries.
 * Required fields:
 *  postedAt, accountKey, dc ("debit"/"credit"), amount
 */
export async function computeDailyCloseFromLedger({ db, fromUtc, toUtc }) {
  const Ledger = db.collection("gl_ledger_entries");

  // 1) Day aggregation per account
  const dayAgg = await Ledger.aggregate([
    { $match: { postedAt: { $gte: fromUtc, $lt: toUtc } } },
    {
      $group: {
        _id: "$accountKey",
        inflow: {
          $sum: {
            $cond: [{ $eq: ["$dc", "credit"] }, "$amount", 0],
          },
        },
        outflow: {
          $sum: {
            $cond: [{ $eq: ["$dc", "debit"] }, "$amount", 0],
          },
        },
        ledgerCount: { $sum: 1 },
        maxPostedAt: { $max: "$postedAt" },
      },
    },
    {
      $project: {
        _id: 0,
        accountKey: "$_id",
        inflow: 1,
        outflow: 1,
        net: { $subtract: ["$inflow", "$outflow"] },
        ledgerCount: 1,
        maxPostedAt: 1,
      },
    },
  ]).toArray();

  // 2) Opening balance per account = net before fromUtc
  const openAgg = await Ledger.aggregate([
    { $match: { postedAt: { $lt: fromUtc } } },
    {
      $group: {
        _id: "$accountKey",
        // opening net = credits - debits up to start of day
        opening: {
          $sum: {
            $cond: [
              { $eq: ["$dc", "credit"] },
              "$amount",
              { $multiply: ["$amount", -1] }, // debit subtract
            ],
          },
        },
      },
    },
    { $project: { _id: 0, accountKey: "$_id", opening: 1 } },
  ]).toArray();

  const openingByAccount = new Map(openAgg.map((r) => [String(r.accountKey), Number(r.opening || 0)]));

  // 3) Combine into perAccount array
  const perAccount = dayAgg.map((r) => {
    const key = String(r.accountKey);
    const opening = openingByAccount.get(key) ?? 0;
    const inflow = Number(r.inflow || 0);
    const outflow = Number(r.outflow || 0);
    const net = Number(r.net || 0);
    const closing = opening + net;

    return {
      accountKey: key,
      opening,
      inflow,
      outflow,
      net,
      closing,
    };
  });

  // 4) Totals
  let totalsIn = 0;
  let totalsOut = 0;
  for (const r of dayAgg) {
    totalsIn += Number(r.inflow || 0);
    totalsOut += Number(r.outflow || 0);
  }

  // 5) Audit
  const ledgerCount = dayAgg.reduce((s, r) => s + (r.ledgerCount || 0), 0);
  const maxPostedAt = dayAgg.reduce((m, r) => {
    if (!r.maxPostedAt) return m;
    const t = new Date(r.maxPostedAt).getTime();
    return t > m ? t : m;
  }, 0);

  return {
    totals: {
      inflow: totalsIn,
      outflow: totalsOut,
      net: totalsIn - totalsOut,
    },
    perAccount,
    audit: {
      ledgerCount,
      maxPostedAt: maxPostedAt ? new Date(maxPostedAt) : null,
    },
  };
}
