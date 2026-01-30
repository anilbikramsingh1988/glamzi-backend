import { connectDb } from "../db.js";

export function emailTemplateVersionsCollection(db) {
  return db.collection("emailTemplateVersions");
}

export async function getEmailTemplateVersions() {
  const db = await connectDb();
  return emailTemplateVersionsCollection(db);
}
