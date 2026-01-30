import { ObjectId } from "mongodb";
import { client } from "../dbConfig.js";
import { sendSellerPushNotification } from "./sellerPush.js";
import { sendAdminPushNotification } from "./adminPush.js";

const db = client.db(process.env.DB_NAME || "glamzi_ecommerce");

const SellerNotifications = db.collection("seller_notifications");
const CustomerNotifications = db.collection("customerNotifications");
const AdminNotifications = db.collection("admin_notifications");

const toObjectIdSafe = (val) => {
  if (!val) return null;
  if (val instanceof ObjectId) return val;
  try {
    return new ObjectId(val);
  } catch {
    return null;
  }
};

export async function notifySeller({
  sellerId,
  type,
  title,
  body,
  link,
  meta = {},
  push = true,
}) {
  if (!sellerId) return;
  const createdAt = new Date();
  const sid = String(sellerId);

  await SellerNotifications.insertOne({
    sellerId: sid,
    type: type || "info",
    title: title || "",
    body: body || "",
    link: link || "/seller/dashboard",
    meta,
    read: false,
    createdAt,
  });

  if (push) {
    await sendSellerPushNotification({
      sellerId: sid,
      title: title || "Glamzi Seller",
      body: body || "",
      url: link || "/seller/dashboard",
      data: meta,
    });
  }
}

export async function notifyCustomer({
  customerId,
  type,
  title,
  body,
  link,
  meta = {},
  orderId,
  orderNumber,
}) {
  if (!customerId) return;
  const createdAt = new Date();
  const cidObj = toObjectIdSafe(customerId);

  await CustomerNotifications.insertOne({
    userId: cidObj || String(customerId),
    orderId: orderId || null,
    orderNumber: orderNumber || null,
    type: type || "info",
    title: title || "",
    body: body || "",
    link: link || "/orders",
    meta,
    isRead: false,
    createdAt,
  });
}

export async function notifyAdmin({
  type,
  title,
  message,
  link,
  meta = {},
  push = true,
}) {
  const createdAt = new Date();
  await AdminNotifications.insertOne({
    type: type || "info",
    title: title || "",
    message: message || "",
    link: link || "/",
    meta,
    read: false,
    createdAt,
  });

  if (push) {
    await sendAdminPushNotification({
      title: title || "Glamzi Admin",
      body: message || "",
      url: link || "/",
      data: meta,
    });
  }
}

export { toObjectIdSafe };
