import { connectDb } from "../db.js";

export function emailTemplateUsageLogCollection(db) {
  return db.collection("emailTemplateUsageLog");
}

export async function getEmailTemplateUsageLog() {
  const db = await connectDb();
  return emailTemplateUsageLogCollection(db);
}
