import fs from "fs";
import path from "path";

const LOG_DIR = path.join(process.cwd() || ".", "backend", "logs");
const LOG_FILE = path.join(LOG_DIR, "returns.log");

async function ensureLogDir() {
  try {
    await fs.promises.mkdir(LOG_DIR, { recursive: true });
  } catch (err) {
    console.error("Failed to create return log directory:", err);
  }
}

export async function logReturnIssue(type, details = {}) {
  try {
    await ensureLogDir();
    const payload = {
      at: new Date().toISOString(),
      type,
      details,
    };
    await fs.promises.appendFile(LOG_FILE, `${JSON.stringify(payload)}\n`);
  } catch (err) {
    console.error("Failed to write return log entry:", err);
  }
}
