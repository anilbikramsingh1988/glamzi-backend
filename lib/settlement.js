// backend/lib/settlement.js (ESM)
import { computeDailyCloseFromLedger } from "./dailyClose.js";
import { makeRunId, businessDayWindowUtc, nowUtcDate } from "./time.js";
import { acquireLock, releaseLock, makeLockOwner } from "./lock.js";

export async function ensureSettlementIndexes(db) {
  const runs = db.collection("gl_settlement_runs");
  const snaps = db.collection("gl_daily_account_snapshots");
  const cod = db.collection("gl_daily_cod_settlements");
  const sellers = db.collection("gl_daily_seller_settlements");
  const commission = db.collection("gl_daily_commission_snapshots");
  const reports = db.collection("gl_daily_financial_reports");

  await Promise.all([
    runs.createIndex({ businessDate: 1 }, { unique: true, name: "uniq_businessDate" }),
    runs.createIndex({ status: 1, businessDate: 1 }, { name: "status_businessDate" }),
    snaps.createIndex({ businessDate: 1, accountKey: 1 }, { unique: true, name: "uniq_bd_account" }),
    snaps.createIndex({ accountKey: 1, businessDate: -1 }, { name: "account_bd_desc" }),
    cod.createIndex({ businessDate: 1 }, { unique: true, name: "uniq_bd_cod" }),
    sellers.createIndex({ businessDate: 1, sellerId: 1 }, { unique: true, name: "uniq_bd_seller" }),
    sellers.createIndex({ sellerId: 1, businessDate: -1 }, { name: "seller_bd_desc" }),
    commission.createIndex({ businessDate: 1 }, { unique: true, name: "uniq_bd_commission" }),
    reports.createIndex({ businessDate: 1 }, { unique: true, name: "uniq_bd_report" }),
  ]);
}

function resolveWindowFromClose(closeDoc) {
  const dateKey = closeDoc?.dateKey || closeDoc?.businessDate;
  const range = closeDoc?.range;
  if (range?.from && range?.to) {
    return {
      businessDate: dateKey,
      fromUtc: new Date(range.from),
      toUtc: new Date(range.to),
    };
  }
  if (dateKey) return businessDayWindowUtc(dateKey);
  throw new Error("Missing businessDate/range for settlement window");
}

export async function snapshotAccounts({ db, businessDate, window, closeId, runId }) {
  const computed = await computeDailyCloseFromLedger({
    db,
    fromUtc: window.fromUtc,
    toUtc: window.toUtc,
  });

  const snaps = db.collection("gl_daily_account_snapshots");
  const now = nowUtcDate();

  const ops = computed.perAccount.map((row) => ({
    replaceOne: {
      filter: { businessDate, accountKey: row.accountKey },
      replacement: {
        businessDate,
        window: { from: window.fromUtc, to: window.toUtc },
        accountKey: row.accountKey,
        openingBalance: row.opening,
        inflow: row.inflow,
        outflow: row.outflow,
        net: row.net,
        closingBalance: row.closing,
        closeId: closeId || null,
        runId: runId || null,
        ledgerCount: computed.audit?.ledgerCount || 0,
        maxPostedAt: computed.audit?.maxPostedAt || null,
        createdAt: now,
        updatedAt: now,
      },
      upsert: true,
    },
  }));

  if (ops.length) {
    await snaps.bulkWrite(ops, { ordered: false });
  }

  return {
    ok: true,
    accounts: computed.perAccount.length,
    ledgerCount: computed.audit?.ledgerCount || 0,
    totals: computed.totals,
  };
}

export async function snapshotCodSettlements({ db, businessDate, window, closeId, runId }) {
  const Ledger = db.collection("gl_ledger_entries");
  const now = nowUtcDate();

  const match = {
    postedAt: { $gte: window.fromUtc, $lt: window.toUtc },
    category: "cod_marked_paid",
  };

  const [totals] = await Ledger.aggregate([
    { $match: match },
    {
      $group: {
        _id: null,
        credit: { $sum: { $cond: [{ $eq: ["$dc", "credit"] }, "$amount", 0] } },
        debit: { $sum: { $cond: [{ $eq: ["$dc", "debit"] }, "$amount", 0] } },
        count: { $sum: 1 },
      },
    },
  ]).toArray();

  const bySeller = await Ledger.aggregate([
    { $match: match },
    {
      $addFields: {
        sellerId: {
          $cond: [
            { $regexMatch: { input: "$accountKey", regex: /^seller:/ } },
            { $arrayElemAt: [{ $split: ["$accountKey", ":"] }, 1] },
            null,
          ],
        },
      },
    },
    { $match: { sellerId: { $ne: null } } },
    {
      $group: {
        _id: "$sellerId",
        credit: { $sum: { $cond: [{ $eq: ["$dc", "credit"] }, "$amount", 0] } },
        debit: { $sum: { $cond: [{ $eq: ["$dc", "debit"] }, "$amount", 0] } },
      },
    },
    {
      $project: {
        _id: 0,
        sellerId: "$_id",
        credit: 1,
        debit: 1,
        net: { $subtract: ["$credit", "$debit"] },
      },
    },
  ]).toArray();

  const credit = Number(totals?.credit || 0);
  const debit = Number(totals?.debit || 0);
  const count = Number(totals?.count || 0);

  const doc = {
    businessDate,
    window: { from: window.fromUtc, to: window.toUtc },
    totals: {
      credit,
      debit,
      net: credit - debit,
    },
    count,
    bySeller,
    closeId: closeId || null,
    runId: runId || null,
    createdAt: now,
    updatedAt: now,
  };

  await db.collection("gl_daily_cod_settlements").replaceOne(
    { businessDate },
    doc,
    { upsert: true }
  );

  return { ok: true, count, credit, debit, net: credit - debit, sellers: bySeller.length };
}

export async function snapshotSellerSettlements({ db, businessDate, window, closeId, runId }) {
  const Ledger = db.collection("gl_ledger_entries");
  const now = nowUtcDate();

  const sellerRows = await Ledger.aggregate([
    { $match: { postedAt: { $gte: window.fromUtc, $lt: window.toUtc } } },
    {
      $addFields: {
        sellerId: {
          $cond: [
            { $regexMatch: { input: "$accountKey", regex: /^seller:/ } },
            { $arrayElemAt: [{ $split: ["$accountKey", ":"] }, 1] },
            null,
          ],
        },
      },
    },
    { $match: { sellerId: { $ne: null } } },
    {
      $group: {
        _id: "$sellerId",
        credit: { $sum: { $cond: [{ $eq: ["$dc", "credit"] }, "$amount", 0] } },
        debit: { $sum: { $cond: [{ $eq: ["$dc", "debit"] }, "$amount", 0] } },
        count: { $sum: 1 },
      },
    },
    {
      $project: {
        _id: 0,
        sellerId: "$_id",
        credit: 1,
        debit: 1,
        net: { $subtract: ["$credit", "$debit"] },
        count: 1,
      },
    },
  ]).toArray();

  const ops = sellerRows.map((row) => ({
    replaceOne: {
      filter: { businessDate, sellerId: row.sellerId },
      replacement: {
        businessDate,
        window: { from: window.fromUtc, to: window.toUtc },
        sellerId: row.sellerId,
        credit: row.credit,
        debit: row.debit,
        net: row.net,
        entryCount: row.count,
        closeId: closeId || null,
        runId: runId || null,
        createdAt: now,
        updatedAt: now,
      },
      upsert: true,
    },
  }));

  if (ops.length) {
    await db.collection("gl_daily_seller_settlements").bulkWrite(ops, { ordered: false });
  }

  const totals = sellerRows.reduce(
    (acc, r) => {
      acc.credit += Number(r.credit || 0);
      acc.debit += Number(r.debit || 0);
      return acc;
    },
    { credit: 0, debit: 0 }
  );

  return {
    ok: true,
    sellers: sellerRows.length,
    credit: totals.credit,
    debit: totals.debit,
    net: totals.credit - totals.debit,
  };
}

export async function snapshotCommission({ db, businessDate, window, closeId, runId }) {
  const Ledger = db.collection("gl_ledger_entries");
  const now = nowUtcDate();

  const [totals] = await Ledger.aggregate([
    {
      $match: {
        postedAt: { $gte: window.fromUtc, $lt: window.toUtc },
        accountKey: "platform:commission",
      },
    },
    {
      $group: {
        _id: null,
        credit: { $sum: { $cond: [{ $eq: ["$dc", "credit"] }, "$amount", 0] } },
        debit: { $sum: { $cond: [{ $eq: ["$dc", "debit"] }, "$amount", 0] } },
        count: { $sum: 1 },
      },
    },
  ]).toArray();

  const credit = Number(totals?.credit || 0);
  const debit = Number(totals?.debit || 0);
  const doc = {
    businessDate,
    window: { from: window.fromUtc, to: window.toUtc },
    totals: {
      credit,
      debit,
      net: credit - debit,
    },
    count: Number(totals?.count || 0),
    closeId: closeId || null,
    runId: runId || null,
    createdAt: now,
    updatedAt: now,
  };

  await db.collection("gl_daily_commission_snapshots").replaceOne(
    { businessDate },
    doc,
    { upsert: true }
  );

  return { ok: true, credit, debit, net: credit - debit, count: doc.count };
}

export async function snapshotReport({ db, businessDate, window, closeId, runId }) {
  const now = nowUtcDate();
  const accountSnap = await db.collection("gl_daily_account_snapshots").find({ businessDate }).toArray();
  const codSnap = await db.collection("gl_daily_cod_settlements").findOne({ businessDate });
  const sellerSnap = await db.collection("gl_daily_seller_settlements").find({ businessDate }).toArray();
  const commissionSnap = await db.collection("gl_daily_commission_snapshots").findOne({ businessDate });

  const report = {
    businessDate,
    window: { from: window.fromUtc, to: window.toUtc },
    snapshots: {
      accountsCount: accountSnap.length,
      cod: codSnap?._id || null,
      sellersCount: sellerSnap.length,
      commission: commissionSnap?._id || null,
    },
    summary: {
      accountNet: accountSnap.reduce((s, r) => s + Number(r.net || 0), 0),
      codNet: codSnap ? codSnap?.totals?.net || 0 : 0,
      sellerNet: sellerSnap.reduce((s, r) => s + Number(r.net || 0), 0),
      commissionNet: commissionSnap ? commissionSnap?.totals?.net || 0 : 0,
    },
    closeId: closeId || null,
    runId: runId || null,
    createdAt: now,
    updatedAt: now,
  };

  await db.collection("gl_daily_financial_reports").replaceOne(
    { businessDate },
    report,
    { upsert: true }
  );

  return {
    ok: true,
    accounts: accountSnap.length,
    sellers: sellerSnap.length,
    codNet: report.summary.codNet,
    commissionNet: report.summary.commissionNet,
  };
}

export async function processSettlementRunFromClose({ db, closeDoc, log = console }) {
  const businessDate = closeDoc?.dateKey || closeDoc?.businessDate;
  if (!businessDate) {
    log.warn?.("[settlement] skip close with no businessDate");
    return;
  }

  const window = resolveWindowFromClose(closeDoc);
  const runs = db.collection("gl_settlement_runs");
  const runId = makeRunId();
  const owner = makeLockOwner();
  const lockKey = `settlement_run_${businessDate}`;
  let lock = null;

  // fast-path: if already completed run exists, skip before locking
  const existingRun = await runs.findOne(
    { businessDate, status: "COMPLETED" },
    { projection: { _id: 1, status: 1 } }
  );
  if (existingRun) {
    log.info?.(`[settlement] ALREADY_COMPLETED businessDate=${businessDate}`);
    return;
  }

  try {
    lock = await acquireLock({
      db,
      key: lockKey,
      owner,
      runId,
      leaseMs: Number(process.env.SETTLEMENT_LEASE_MS || 5 * 60 * 1000),
    });

    if (!lock?.ok) {
      log.info?.(`[settlement] lock not acquired for ${businessDate}: ${lock?.reason || "held"}`);
      return;
    }

    const now = nowUtcDate();
    const runDoc = await runs.findOneAndUpdate(
      { businessDate },
      {
        $setOnInsert: {
          businessDate,
          window: { from: window.fromUtc, to: window.toUtc },
          status: "PENDING",
          createdAt: now,
        },
        $set: {
          closeId: closeDoc?._id || null,
          window: { from: window.fromUtc, to: window.toUtc },
          updatedAt: now,
        },
      },
      { upsert: true, returnDocument: "after" }
    );

    if (runDoc.value?.status === "COMPLETED") {
      log.info?.(`[settlement] already completed run for ${businessDate}`);
      return;
    }

    await runs.updateOne(
      { _id: runDoc.value?._id },
      {
        $set: {
          status: "RUNNING",
          runId,
          startedAt: now,
          updatedAt: now,
          "steps.snapshot_accounts.status": "RUNNING",
          "steps.snapshot_accounts.startedAt": now,
          "steps.snapshot_accounts.attempts": (runDoc.value?.steps?.snapshot_accounts?.attempts || 0) + 1,
        },
      }
    );

    const snapRes = await snapshotAccounts({
      db,
      businessDate,
      window,
      closeId: closeDoc?._id || null,
      runId,
    });

    await runs.updateOne(
      { _id: runDoc.value?._id },
      {
        $set: {
          "steps.snapshot_accounts.status": "COMPLETED",
          "steps.snapshot_accounts.finishedAt": nowUtcDate(),
          "steps.snapshot_accounts.result": snapRes,
        },
      }
    );

    log.info?.(
      `[settlement] snapshot_accounts COMPLETE businessDate=${businessDate} accounts=${snapRes.accounts} ledgerCount=${snapRes.ledgerCount}`
    );

    // Step 2: COD snapshot
    await runs.updateOne(
      { _id: runDoc.value?._id },
      {
        $set: {
          "steps.snapshot_cod.status": "RUNNING",
          "steps.snapshot_cod.startedAt": nowUtcDate(),
          "steps.snapshot_cod.attempts": (runDoc.value?.steps?.snapshot_cod?.attempts || 0) + 1,
        },
      }
    );

    const codRes = await snapshotCodSettlements({
      db,
      businessDate,
      window,
      closeId: closeDoc?._id || null,
      runId,
    });

    await runs.updateOne(
      { _id: runDoc.value?._id },
      {
        $set: {
          "steps.snapshot_cod.status": "COMPLETED",
          "steps.snapshot_cod.finishedAt": nowUtcDate(),
          "steps.snapshot_cod.result": codRes,
        },
      }
    );

    log.info?.(
      `[settlement] snapshot_cod COMPLETE businessDate=${businessDate} entries=${codRes.count} net=${codRes.net}`
    );

    // Step 3: Seller settlements
    await runs.updateOne(
      { _id: runDoc.value?._id },
      {
        $set: {
          "steps.snapshot_seller.status": "RUNNING",
          "steps.snapshot_seller.startedAt": nowUtcDate(),
          "steps.snapshot_seller.attempts": (runDoc.value?.steps?.snapshot_seller?.attempts || 0) + 1,
        },
      }
    );

    const sellerRes = await snapshotSellerSettlements({
      db,
      businessDate,
      window,
      closeId: closeDoc?._id || null,
      runId,
    });

    await runs.updateOne(
      { _id: runDoc.value?._id },
      {
        $set: {
          "steps.snapshot_seller.status": "COMPLETED",
          "steps.snapshot_seller.finishedAt": nowUtcDate(),
          "steps.snapshot_seller.result": sellerRes,
        },
      }
    );

    log.info?.(
      `[settlement] snapshot_seller COMPLETE businessDate=${businessDate} sellers=${sellerRes.sellers} net=${sellerRes.net}`
    );

    // Step 4: Commission snapshot
    await runs.updateOne(
      { _id: runDoc.value?._id },
      {
        $set: {
          "steps.snapshot_commission.status": "RUNNING",
          "steps.snapshot_commission.startedAt": nowUtcDate(),
          "steps.snapshot_commission.attempts": (runDoc.value?.steps?.snapshot_commission?.attempts || 0) + 1,
        },
      }
    );

    const commissionRes = await snapshotCommission({
      db,
      businessDate,
      window,
      closeId: closeDoc?._id || null,
      runId,
    });

    await runs.updateOne(
      { _id: runDoc.value?._id },
      {
        $set: {
          "steps.snapshot_commission.status": "COMPLETED",
          "steps.snapshot_commission.finishedAt": nowUtcDate(),
          "steps.snapshot_commission.result": commissionRes,
        },
      }
    );

    log.info?.(
      `[settlement] snapshot_commission COMPLETE businessDate=${businessDate} net=${commissionRes.net}`
    );

    // Step 5: Final report
    await runs.updateOne(
      { _id: runDoc.value?._id },
      {
        $set: {
          "steps.final_report.status": "RUNNING",
          "steps.final_report.startedAt": nowUtcDate(),
          "steps.final_report.attempts": (runDoc.value?.steps?.final_report?.attempts || 0) + 1,
        },
      }
    );

    const reportRes = await snapshotReport({
      db,
      businessDate,
      window,
      closeId: closeDoc?._id || null,
      runId,
    });

    await runs.updateOne(
      { _id: runDoc.value?._id },
      {
        $set: {
          "steps.final_report.status": "COMPLETED",
          "steps.final_report.finishedAt": nowUtcDate(),
          "steps.final_report.result": reportRes,
        },
      }
    );

    log.info?.(
      `[settlement] final_report COMPLETE businessDate=${businessDate} accounts=${reportRes.accounts} sellers=${reportRes.sellers}`
    );

    const finishedAt = nowUtcDate();
    await runs.updateOne(
      { _id: runDoc.value?._id },
      {
        $set: {
          status: "COMPLETED",
          finishedAt,
          updatedAt: finishedAt,
        },
      }
    );

    return;
  } catch (err) {
    log.error?.("[settlement] failed", err);
    const now = nowUtcDate();
    await db
      .collection("gl_settlement_runs")
      .updateOne(
        { businessDate },
        {
          $set: {
            status: "FAILED",
            updatedAt: now,
            "steps.snapshot_accounts.status": "FAILED",
            "steps.snapshot_accounts.error": err?.message || String(err),
            "steps.snapshot_accounts.finishedAt": now,
          },
        }
      )
      .catch(() => {});
  } finally {
    if (lock?.ok) {
      try {
        await releaseLock({ db, key: lockKey, owner });
      } catch (e) {
        log.error?.("[settlement] WARN lock release failed", e?.message || e);
      }
    }
  }
}
