import { processOutboxBatch } from "../workers/outboxWorker.js";

const limit = Number(process.env.OUTBOX_BATCH_LIMIT || 25);

processOutboxBatch(limit)
  .then((count) => {
    // eslint-disable-next-line no-console
    console.log(`[outbox] processed ${count} event(s)`);
    process.exit(0);
  })
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error("[outbox] batch failed:", err);
    process.exit(1);
  });
