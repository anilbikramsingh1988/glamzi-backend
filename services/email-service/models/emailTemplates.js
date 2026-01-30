import { connectDb } from "../db.js";

export function emailTemplatesCollection(db) {
  return db.collection("emailTemplates");
}

export async function getEmailTemplates() {
  const db = await connectDb();
  return emailTemplatesCollection(db);
}
