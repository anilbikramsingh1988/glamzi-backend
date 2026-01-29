import webpush from "web-push";
import { client } from "../dbConfig.js";

const dbName = process.env.DB_NAME || "glamzi_ecommerce";
const db = client.db(dbName);
const SellerPushSubscriptions = db.collection("seller_push_subscriptions");

let vapidConfigured = false;

function ensureVapid() {
  if (vapidConfigured) return true;
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) return false;

  const subject = process.env.VAPID_SUBJECT || "mailto:admin@glamzibeauty.com";
  webpush.setVapidDetails(subject, publicKey, privateKey);
  vapidConfigured = true;
  return true;
}

export function getVapidPublicKey() {
  return process.env.VAPID_PUBLIC_KEY || "";
}

export async function upsertSellerSubscription({ subscription, userId, sellerId }) {
  if (!subscription?.endpoint) {
    throw new Error("Subscription endpoint is required");
  }

  const now = new Date();
  const doc = {
    endpoint: subscription.endpoint,
    keys: subscription.keys || {},
    expirationTime: subscription.expirationTime || null,
    userId: userId ? String(userId) : null,
    sellerId: sellerId ? String(sellerId) : null,
    active: true,
    updatedAt: now,
  };

  await SellerPushSubscriptions.updateOne(
    { endpoint: subscription.endpoint },
    {
      $set: doc,
      $setOnInsert: { createdAt: now },
    },
    { upsert: true }
  );
}

export async function removeSellerSubscription(endpoint) {
  if (!endpoint) return;
  await SellerPushSubscriptions.updateOne(
    { endpoint },
    { $set: { active: false, updatedAt: new Date() } }
  );
}

export async function sendSellerPushNotification({ sellerId, title, body, url, data }) {
  if (!ensureVapid()) return { skipped: true };
  if (!sellerId) return { skipped: true };

  const payload = JSON.stringify({
    title: title || "Glamzi Seller",
    body: body || "",
    url: url || "/seller/dashboard",
    data: data || {},
  });

  const subs = await SellerPushSubscriptions.find({
    active: true,
    sellerId: String(sellerId),
  }).toArray();

  if (!subs.length) return { sent: 0 };

  let sent = 0;
  for (const sub of subs) {
    try {
      await webpush.sendNotification(
        {
          endpoint: sub.endpoint,
          keys: sub.keys || {},
        },
        payload
      );
      sent += 1;
    } catch (err) {
      const status = err?.statusCode || err?.status;
      if (status === 404 || status === 410) {
        await SellerPushSubscriptions.updateOne(
          { endpoint: sub.endpoint },
          { $set: { active: false, updatedAt: new Date() } }
        );
      } else {
        console.error("Seller push send error:", err?.message || err);
      }
    }
  }

  return { sent };
}
