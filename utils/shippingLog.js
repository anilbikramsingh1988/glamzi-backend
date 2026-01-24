import fs from "fs";
import path from "path";

const LOG_DIR = path.join(process.cwd() || ".", "backend", "logs");
const SHIPPING_LOG = path.join(LOG_DIR, "shipping-booking.log");

async function ensureDir() {
  try {
    await fs.promises.mkdir(LOG_DIR, { recursive: true });
  } catch (err) {
    console.error("Failed to create shipping log directory:", err);
  }
}

async function appendLog(entry) {
  try {
    await ensureDir();
    await fs.promises.appendFile(SHIPPING_LOG, `${JSON.stringify(entry)}\n`);
  } catch (err) {
    console.error("Failed to write shipping log entry:", err);
  }
}

export async function logShippingBookingFailure({ returnId, orderId, attempt, payload, error, stage, status, response }) {
  const entry = {
    at: new Date().toISOString(),
    stage: stage || "book",
    returnId: returnId ? String(returnId) : null,
    orderId: orderId ? String(orderId) : null,
    attempt: Number(attempt || 0),
    payloadSnapshot: payload || null,
    error: String(error || "unknown"),
    status: Number.isFinite(Number(status)) ? Number(status) : null,
    response: response || null,
  };
  await appendLog(entry);
}
