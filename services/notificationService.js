import { ObjectId } from "mongodb";
import { client } from "../dbConfig.js";

const db = client.db(process.env.DB_NAME || "glamzi_ecommerce");
const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

async function sendPushNotification(tokens, title, body, data = {}) {
  if (!tokens || tokens.length === 0) return { success: false, error: "No tokens" };

  const messages = tokens.map(token => ({
    to: token,
    sound: "default",
    title,
    body,
    data
  }));

  try {
    const response = await fetch(EXPO_PUSH_URL, {
      method: "POST",
      headers: {
        "Accept": "application/json",
        "Accept-Encoding": "gzip, deflate",
        "Content-Type": "application/json"
      },
      body: JSON.stringify(messages)
    });
    const result = await response.json();
    return { success: true, result };
  } catch (error) {
    console.error("Push notification error:", error);
    return { success: false, error: error.message };
  }
}

async function getUserTokens(userId, userType = "customer") {
  const tokens = await db.collection("push_tokens")
    .find({ 
      userId: new ObjectId(userId),
      userType,
      isActive: true 
    })
    .project({ token: 1 })
    .toArray();
  
  return tokens.map(t => t.token);
}

async function checkUserPreference(userId, preferenceKey) {
  const prefs = await db.collection("notification_preferences").findOne({
    userId: new ObjectId(userId)
  });

  if (!prefs || !prefs.settings) return true;
  return prefs.settings[preferenceKey] !== false;
}

export async function notifyOrderPlaced(orderId, customerId) {
  try {
    const shouldNotify = await checkUserPreference(customerId, "orderUpdates");
    if (!shouldNotify) return;

    const tokens = await getUserTokens(customerId, "customer");
    if (tokens.length === 0) return;

    await sendPushNotification(
      tokens,
      "Order Placed Successfully!",
      `Your order #${orderId.toString().slice(-8)} has been placed.`,
      { type: "order_placed", orderId: orderId.toString() }
    );
  } catch (error) {
    console.error("Error sending order placed notification:", error);
  }
}

export async function notifyOrderStatusChange(orderId, customerId, status) {
  try {
    const shouldNotify = await checkUserPreference(customerId, "orderUpdates");
    if (!shouldNotify) return;

    const tokens = await getUserTokens(customerId, "customer");
    if (tokens.length === 0) return;

    const statusMessages = {
      processing: "Your order is now being processed.",
      shipped: "Great news! Your order has been shipped.",
      delivered: "Your order has been delivered!",
      cancelled: "Your order has been cancelled.",
      returned: "Your return has been processed."
    };

    const message = statusMessages[status] || `Order status updated to ${status}`;

    await sendPushNotification(
      tokens,
      "Order Update",
      message,
      { type: "order_status", orderId: orderId.toString(), status }
    );
  } catch (error) {
    console.error("Error sending order status notification:", error);
  }
}

export async function notifyNewMessage(recipientId, recipientType, senderName) {
  try {
    const shouldNotify = await checkUserPreference(recipientId, "newMessages");
    if (!shouldNotify) return;

    const tokens = await getUserTokens(recipientId, recipientType);
    if (tokens.length === 0) return;

    await sendPushNotification(
      tokens,
      "New Message",
      `You have a new message from ${senderName}`,
      { type: "new_message" }
    );
  } catch (error) {
    console.error("Error sending message notification:", error);
  }
}

export async function notifyNewOrderToSeller(sellerId, orderDetails) {
  try {
    const shouldNotify = await checkUserPreference(sellerId, "newOrders");
    if (!shouldNotify) return;

    const tokens = await getUserTokens(sellerId, "seller");
    if (tokens.length === 0) return;

    await sendPushNotification(
      tokens,
      "New Order Received!",
      `You have a new order worth Rs. ${orderDetails.total}`,
      { type: "new_order", orderId: orderDetails.orderId?.toString() }
    );
  } catch (error) {
    console.error("Error sending new order notification to seller:", error);
  }
}

export async function notifyLowStock(sellerId, productName, currentStock) {
  try {
    const shouldNotify = await checkUserPreference(sellerId, "lowStock");
    if (!shouldNotify) return;

    const tokens = await getUserTokens(sellerId, "seller");
    if (tokens.length === 0) return;

    await sendPushNotification(
      tokens,
      "Low Stock Alert",
      `${productName} has only ${currentStock} units left.`,
      { type: "low_stock" }
    );
  } catch (error) {
    console.error("Error sending low stock notification:", error);
  }
}

export async function notifyPromotion(title, body, targetAudience = "customers") {
  try {
    let tokenFilter = { isActive: true };
    
    if (targetAudience === "customers") {
      tokenFilter.userType = "customer";
    } else if (targetAudience === "sellers") {
      tokenFilter.userType = "seller";
    }

    const tokens = await db.collection("push_tokens")
      .find(tokenFilter)
      .project({ token: 1 })
      .toArray();

    if (tokens.length === 0) return;

    const tokenStrings = tokens.map(t => t.token);
    
    const batchSize = 100;
    for (let i = 0; i < tokenStrings.length; i += batchSize) {
      const batch = tokenStrings.slice(i, i + batchSize);
      await sendPushNotification(batch, title, body, { type: "promotion" });
    }
  } catch (error) {
    console.error("Error sending promotion notification:", error);
  }
}

export default {
  notifyOrderPlaced,
  notifyOrderStatusChange,
  notifyNewMessage,
  notifyNewOrderToSeller,
  notifyLowStock,
  notifyPromotion
};
