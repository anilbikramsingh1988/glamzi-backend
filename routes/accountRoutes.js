// routes/accountRoutes.js – customer “My Account” + seller configuration

import express from "express";
import { authMiddleware } from "../middlewares/authMiddleware.js";
import { client } from "../dbConfig.js";
import { ObjectId } from "mongodb";

const router = express.Router();

// Use your existing DB
const db = client.db("glamzi_ecommerce");

// Collections
const Orders = db.collection("orders");
const Conversations = db.collection("conversations");
const Messages = db.collection("messages");
const Payments = db.collection("payments");
const ReturnRequests = db.collection("returnRequests");
const ShippingAddresses = db.collection("shippingAddresses");
const Users = db.collection("users");
const SellerSettings = db.collection("seller_settings"); // ✅ NEW

/**
 * Helper: safely get logged-in user's ID as a string
 */
function getUserId(req) {
  return String(req.user?.id || req.user?._id || req.user?.userId || "");
}

/**
 * ✅ Helper: customer filter for both string + ObjectId customerId
 * Used only where we query ShippingAddresses by customerId
 */
function getCustomerFilter(userId) {
  if (ObjectId.isValid(userId)) {
    return {
      $or: [{ customerId: userId }, { customerId: new ObjectId(userId) }],
    };
  }
  return { customerId: userId };
}

/* ============================================================================
 * 0) SELLER CONFIGURATION SETTINGS
 *    - /api/seller/settings/notifications
 *    - /api/seller/settings/payment
 *    - /api/seller/settings/shipping
 *    - /api/seller/settings/invoice
 * ========================================================================== */

/**
 * ✅ Helper: get or create seller settings doc
 */
async function getOrCreateSettings(sellerId) {
  let settings = await SellerSettings.findOne({ sellerId });

  if (!settings) {
    const newSettings = {
      sellerId,
      // general: {}, // ⬅️ no longer used
      notifications: {}, // ✅ new section for notification settings
      payment: {},
      shipping: {},
      invoice: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await SellerSettings.insertOne(newSettings);
    settings = await SellerSettings.findOne({ _id: result.insertedId });
  }

  return settings;
}

const shippingProviderFallback = [
  { key: "everestx", name: "EverestX Logistics", enabled: true },
];

const ACCOUNT_OVERVIEW_FINAL_STATUSES = [
  "delivered",
  "completed",
  "cancelled",
  "return_requested",
];

function normalizeProviderEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  const rawKey =
    entry.key || entry.code || entry.slug || entry.name || entry.label || entry.type || "";
  const key = String(rawKey || "").trim().toLowerCase();
  if (!key) return null;
  const name =
    String(entry.name || entry.label || entry.title || entry.key || entry.code || key).trim() || key;
  const enabled =
    typeof entry.enabled === "boolean"
      ? entry.enabled
      : typeof entry.isEnabled === "boolean"
      ? entry.isEnabled
      : true;
  return { key, name, enabled };
}

/* =========================================================
   ✅ NOTIFICATION SETTINGS (replaces GENERAL)
   ========================================================= */

// GET /api/seller/settings/notifications
router.get("/seller/settings/notifications", authMiddleware, async (req, res) => {
  try {
    const sellerId = getUserId(req);
    if (!sellerId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const settings = await getOrCreateSettings(sellerId);
    res.json({ settings: settings.notifications || {} });
  } catch (err) {
    console.error("Error loading notification settings:", err);
    res.status(500).json({ message: "Failed to load notification settings" });
  }
});

// PUT /api/seller/settings/notifications
router.put("/seller/settings/notifications", authMiddleware, async (req, res) => {
  try {
    const sellerId = getUserId(req);
    if (!sellerId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    await SellerSettings.updateOne(
      { sellerId },
      {
        $set: {
          notifications: req.body,
          updatedAt: new Date(),
        },
      },
      { upsert: true }
    );

    res.json({ message: "Notification settings saved successfully" });
  } catch (err) {
    console.error("Error saving notification settings:", err);
    res.status(500).json({ message: "Failed to save notification settings" });
  }
});

/* =========================================================
   ✅ PAYMENT SETTINGS
   ========================================================= */

// GET /api/seller/settings/payment
router.get("/seller/settings/payment", authMiddleware, async (req, res) => {
  try {
    const sellerId = getUserId(req);
    if (!sellerId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const settings = await getOrCreateSettings(sellerId);
    res.json({ settings: settings.payment || {} });
  } catch (err) {
    console.error("Error loading payment settings:", err);
    res.status(500).json({ message: "Failed to load payment settings" });
  }
});

// PUT /api/seller/settings/payment
router.put("/seller/settings/payment", authMiddleware, async (req, res) => {
  try {
    const sellerId = getUserId(req);
    if (!sellerId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    await SellerSettings.updateOne(
      { sellerId },
      {
        $set: {
          payment: req.body,
          updatedAt: new Date(),
        },
      },
      { upsert: true }
    );

    res.json({ message: "Payment settings saved successfully" });
  } catch (err) {
    console.error("Error saving payment settings:", err);
    res.status(500).json({ message: "Failed to save payment settings" });
  }
});

/* =========================================================
   ✅ SHIPPING SETTINGS
   ========================================================= */

// GET /api/seller/settings/shipping
router.get("/seller/settings/shipping", authMiddleware, async (req, res) => {
  try {
    const sellerId = getUserId(req);
    if (!sellerId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const settings = await getOrCreateSettings(sellerId);
    res.json({ settings: settings.shipping || {} });
  } catch (err) {
    console.error("Error loading shipping settings:", err);
    res.status(500).json({ message: "Failed to load shipping settings" });
  }
});

// PUT /api/seller/settings/shipping
router.put("/seller/settings/shipping", authMiddleware, async (req, res) => {
  try {
    const sellerId = getUserId(req);
    if (!sellerId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    await SellerSettings.updateOne(
      { sellerId },
      {
        $set: {
          shipping: req.body,
          updatedAt: new Date(),
        },
      },
      { upsert: true }
    );

    res.json({ message: "Shipping settings saved successfully" });
  } catch (err) {
    console.error("Error saving shipping settings:", err);
    res.status(500).json({ message: "Failed to save shipping settings" });
  }
});

// GET /api/seller/settings/shipping-partners
router.get("/seller/settings/shipping-partners", authMiddleware, async (req, res) => {
  try {
    const sellerId = getUserId(req);
    if (!sellerId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const settings = await getOrCreateSettings(sellerId);
    const candidates =
      settings.shipping?.providers ||
      settings.shipping?.shippingPartners ||
      settings.shipping?.couriers ||
      settings.shipping?.carriers ||
      [];

    const providers =
      Array.isArray(candidates)
        ? candidates.map(normalizeProviderEntry).filter(Boolean)
        : [];

    return res.json({
      ok: true,
      providers: providers.length ? providers : shippingProviderFallback,
    });
  } catch (err) {
    console.error("Error loading shipping partners:", err);
    return res.status(500).json({ message: "Failed to load shipping partners" });
  }
});

/* =========================================================
   ✅ INVOICE SETTINGS
   ========================================================= */

// GET /api/seller/settings/invoice
router.get("/seller/settings/invoice", authMiddleware, async (req, res) => {
  try {
    const sellerId = getUserId(req);
    if (!sellerId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const settings = await getOrCreateSettings(sellerId);
    res.json({ settings: settings.invoice || {} });
  } catch (err) {
    console.error("Error loading invoice settings:", err);
    res.status(500).json({ message: "Failed to load invoice settings" });
  }
});

// PUT /api/seller/settings/invoice
router.put("/seller/settings/invoice", authMiddleware, async (req, res) => {
  try {
    const sellerId = getUserId(req);
    if (!sellerId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    await SellerSettings.updateOne(
      { sellerId },
      {
        $set: {
          invoice: req.body,
          updatedAt: new Date(),
        },
      },
      { upsert: true }
    );

    res.json({ message: "Invoice settings saved successfully" });
  } catch (err) {
    console.error("Error saving invoice settings:", err);
    res.status(500).json({ message: "Failed to save invoice settings" });
  }
});

/* ============================================================================
 * 1) ORDERS – /api/orders/my-orders
 * ========================================================================== */

/**
 * GET /api/orders/my-orders
 * Returns all orders for the logged-in customer
 */
router.get("/orders/my-orders", authMiddleware, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const orders = await Orders.find({ customerId: userId })
      .sort({ createdAt: -1 })
      .toArray();

    return res.json({ orders });
  } catch (err) {
    console.error("GET /orders/my-orders error:", err);
    return res.status(500).json({
      message: "Failed to load your orders.",
    });
  }
});

/* ============================================================================
 * 2) MESSAGE CENTER (Customer)
 *    - /api/messages/my-conversations
 *    - /api/messages/conversation/:id
 *    - /api/messages/send
 * ========================================================================== */

/**
 * GET /api/messages/my-conversations
 * List all conversations for the logged-in customer
 */
router.get("/messages/my-conversations", authMiddleware, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const conversations = await Conversations.find({ customerId: userId })
      .sort({ updatedAt: -1 })
      .toArray();

    return res.json({ conversations });
  } catch (err) {
    console.error("GET /messages/my-conversations error:", err);
    return res.status(500).json({
      message: "Failed to load conversations.",
    });
  }
});

/**
 * GET /api/messages/conversation/:id
 * Returns messages for a single conversation
 */
router.get("/messages/conversation/:id", authMiddleware, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid conversation id" });
    }

    const conv = await Conversations.findOne({ _id: new ObjectId(id) });
    if (!conv || conv.customerId !== userId) {
      return res.status(404).json({ message: "Conversation not found" });
    }

    const messages = await Messages.find({ conversationId: id })
      .sort({ createdAt: 1 })
      .toArray();

    return res.json({ messages });
  } catch (err) {
    console.error("GET /messages/conversation/:id error:", err);
    return res.status(500).json({
      message: "Failed to load messages.",
    });
  }
});

/**
 * POST /api/messages/send
 * Body: { conversationId, message }
 */
router.post("/messages/send", authMiddleware, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const { conversationId, message } = req.body;
    if (!conversationId || !message || !message.trim()) {
      return res
        .status(400)
        .json({ message: "conversationId and message are required." });
    }

    if (!ObjectId.isValid(conversationId)) {
      return res.status(400).json({ message: "Invalid conversation id" });
    }

    const conv = await Conversations.findOne({
      _id: new ObjectId(conversationId),
    });

    if (!conv || conv.customerId !== userId) {
      return res.status(404).json({ message: "Conversation not found" });
    }

    const now = new Date();
    const newMsg = {
      conversationId,
      sender: userId, // customer
      text: message.trim(),
      createdAt: now,
    };

    const insertRes = await Messages.insertOne(newMsg);

    await Conversations.updateOne(
      { _id: new ObjectId(conversationId) },
      {
        $set: {
          lastMessage: newMsg.text,
          updatedAt: now,
        },
      }
    );

    return res.status(201).json({
      message: { ...newMsg, _id: insertRes.insertedId },
    });
  } catch (err) {
    console.error("POST /messages/send error:", err);
    return res.status(500).json({
      message: "Failed to send message.",
    });
  }
});

/* ============================================================================
 * 3) PAYMENTS
 *    - /api/payments/my-summary
 *    - /api/payments/update-preference
 * ========================================================================== */

/**
 * GET /api/payments/my-summary
 */
router.get("/payments/my-summary", authMiddleware, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    let userDoc = null;
    try {
      if (ObjectId.isValid(userId)) {
        userDoc = await Users.findOne({ _id: new ObjectId(userId) });
      }
    } catch {
      // ignore lookup error
    }

    const payments = await Payments.find({ customerId: userId })
      .sort({ createdAt: -1 })
      .limit(50)
      .toArray();

    let totalPaid = 0;
    let totalRefunded = 0;
    let lastPayment = null;

    for (const p of payments) {
      const status = (p.status || "").toLowerCase();
      const amount =
        typeof p.amount === "number" ? p.amount : Number(p.amount) || 0;

      if (status === "paid" || status === "success") {
        totalPaid += amount;
      }
      if (status === "refunded") {
        totalRefunded += amount;
      }
    }

    if (payments.length > 0) {
      lastPayment = payments[0];
    }

    const preferredMethod = userDoc?.preferredPaymentMethod || "COD";

    return res.json({
      preferredMethod,
      totalPaid,
      totalRefunded,
      lastPayment,
      recentPayments: payments,
    });
  } catch (err) {
    console.error("GET /payments/my-summary error:", err);
    return res.status(500).json({
      message: "Failed to load payment summary.",
    });
  }
});

/**
 * POST /api/payments/update-preference
 * Body: { preferredMethod }
 */
router.post("/payments/update-preference", authMiddleware, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const { preferredMethod } = req.body;
    if (!preferredMethod) {
      return res
        .status(400)
        .json({ message: "preferredMethod is required." });
    }

    if (ObjectId.isValid(userId)) {
      await Users.updateOne(
        { _id: new ObjectId(userId) },
        {
          $set: {
            preferredPaymentMethod: preferredMethod,
            updatedAt: new Date(),
          },
        }
      );
    }

    return res.json({ message: "Payment preference updated." });
  } catch (err) {
    console.error("POST /payments/update-preference error:", err);
    return res.status(500).json({
      message: "Failed to update payment preference.",
    });
  }
});

/* ============================================================================
 * 4) RETURNS & REFUNDS – /api/returns/my-requests
 * ========================================================================== */

/**
 * GET /api/returns/my-requests
 */
router.get("/returns/my-requests", authMiddleware, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const requests = await ReturnRequests.find({ customerId: userId })
      .sort({ createdAt: -1 })
      .toArray();

    return res.json({ requests });
  } catch (err) {
    console.error("GET /returns/my-requests error:", err);
    return res.status(500).json({
      message: "Failed to load return/refund requests.",
    });
  }
});

/* ============================================================================
 * 5) SHIPPING ADDRESSES (Nepal-style)
 *    - /api/account/shipping/addresses
 *    - /api/account/shipping/addresses/:id
 *    - /api/account/shipping/addresses/:id/set-default
 *    - /api/account/shipping/default
 * ========================================================================== */

/**
 * GET /api/account/shipping/addresses
 */
router.get("/account/shipping/addresses", authMiddleware, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const customerFilter = getCustomerFilter(userId);

    const addresses = await ShippingAddresses.find(customerFilter)
      .sort({ createdAt: -1 })
      .toArray();

    const defaultAddr = addresses.find((a) => a.isDefault);
    const defaultAddressId = defaultAddr ? defaultAddr._id : null;

    return res.json({
      addresses,
      defaultAddressId,
      defaultAddress: defaultAddr || null,
    });
  } catch (err) {
    console.error("GET /account/shipping/addresses error:", err);
    return res.status(500).json({
      message: "Failed to load shipping addresses.",
    });
  }
});

/**
 * ✅ NEW: GET /api/account/shipping/default
 * Returns only the default shipping address for the logged-in customer
 */
router.get("/account/shipping/default", authMiddleware, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const customerFilter = getCustomerFilter(userId);

    const addresses = await ShippingAddresses.find(customerFilter)
      .sort({ createdAt: -1 })
      .toArray();

    const defaultAddr = addresses.find((a) => a.isDefault) || addresses[0] || null;

    return res.json({
      address: defaultAddr,
    });
  } catch (err) {
    console.error("GET /account/shipping/default error:", err);
    return res.status(500).json({
      message: "Failed to load default address.",
    });
  }
});

/**
 * POST /api/account/shipping/addresses
 */
router.post("/account/shipping/addresses", authMiddleware, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const {
      fullName,
      phone,
      province,
      district,
      municipalityName,
      wardNumber,
      tole,
      addressLine1,
      addressLine2,
      postalCode,
      isDefault,
    } = req.body;

    if (
      !fullName ||
      !phone ||
      !province ||
      !district ||
      !municipalityName ||
      !wardNumber ||
      !addressLine1
    ) {
      return res.status(400).json({
        message: "Missing required fields for address.",
      });
    }

    const now = new Date();
    const customerFilter = getCustomerFilter(userId);

    if (isDefault) {
      await ShippingAddresses.updateMany(customerFilter, {
        $set: { isDefault: false },
      });
    }

    const insertRes = await ShippingAddresses.insertOne({
      customerId: userId,
      fullName,
      phone,
      province,
      district,
      municipalityName,
      wardNumber: Number(wardNumber),
      tole: tole || "",
      addressLine1,
      addressLine2: addressLine2 || "",
      postalCode: postalCode || "",
      isDefault: !!isDefault,
      createdAt: now,
      updatedAt: now,
    });

    // If no default existed, make this one default
    if (!isDefault) {
      const existingDefault = await ShippingAddresses.findOne({
        ...customerFilter,
        isDefault: true,
      });

      if (!existingDefault) {
        await ShippingAddresses.updateOne(
          { _id: insertRes.insertedId },
          { $set: { isDefault: true } }
        );
      }
    }

    const addresses = await ShippingAddresses.find(customerFilter)
      .sort({ createdAt: -1 })
      .toArray();

    const defaultAddr = addresses.find((a) => a.isDefault);
    const defaultAddressId = defaultAddr ? defaultAddr._id : null;

    return res.status(201).json({
      message: "Address created.",
      addresses,
      defaultAddressId,
      defaultAddress: defaultAddr || null,
    });
  } catch (err) {
    console.error("POST /account/shipping/addresses error:", err);
    return res.status(500).json({
      message: "Failed to create address.",
    });
  }
});

/**
 * PUT /api/account/shipping/addresses/:id
 */
router.put("/account/shipping/addresses/:id", authMiddleware, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid address id" });
    }

    const {
      fullName,
      phone,
      province,
      district,
      municipalityName,
      wardNumber,
      tole,
      addressLine1,
      addressLine2,
      postalCode,
      isDefault,
    } = req.body;

    if (
      !fullName ||
      !phone ||
      !province ||
      !district ||
      !municipalityName ||
      !wardNumber ||
      !addressLine1
    ) {
      return res.status(400).json({
        message: "Missing required fields for address.",
      });
    }

    const existing = await ShippingAddresses.findOne({
      _id: new ObjectId(id),
      customerId: userId,
    });

    if (!existing) {
      return res.status(404).json({ message: "Address not found" });
    }

    const now = new Date();
    const customerFilter = getCustomerFilter(userId);

    if (isDefault) {
      await ShippingAddresses.updateMany(customerFilter, {
        $set: { isDefault: false },
      });
    }

    await ShippingAddresses.updateOne(
      { _id: new ObjectId(id) },
      {
        $set: {
          fullName,
          phone,
          province,
          district,
          municipalityName,
          wardNumber: Number(wardNumber),
          tole: tole || "",
          addressLine1,
          addressLine2: addressLine2 || "",
          postalCode: postalCode || "",
          isDefault: !!isDefault,
          updatedAt: now,
        },
      }
    );

    const addresses = await ShippingAddresses.find(customerFilter)
      .sort({ createdAt: -1 })
      .toArray();

    const defaultAddr = addresses.find((a) => a.isDefault);
    const defaultAddressId = defaultAddr ? defaultAddr._id : null;

    return res.json({
      message: "Address updated.",
      addresses,
      defaultAddressId,
      defaultAddress: defaultAddr || null,
    });
  } catch (err) {
    console.error("PUT /account/shipping/addresses/:id error:", err);
    return res.status(500).json({
      message: "Failed to update address.",
    });
  }
});

/**
 * DELETE /api/account/shipping/addresses/:id
 */
router.delete(
  "/account/shipping/addresses/:id",
  authMiddleware,
  async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) {
        return res.status(401).json({ message: "Unauthorized" });
      }

      const { id } = req.params;
      if (!ObjectId.isValid(id)) {
        return res.status(400).json({ message: "Invalid address id" });
      }

      const existing = await ShippingAddresses.findOne({
        _id: new ObjectId(id),
        customerId: userId,
      });

      if (!existing) {
        return res.status(404).json({ message: "Address not found" });
      }

      await ShippingAddresses.deleteOne({ _id: new ObjectId(id) });

      const customerFilter = getCustomerFilter(userId);

      const addresses = await ShippingAddresses.find(customerFilter)
        .sort({ createdAt: -1 })
        .toArray();

      const defaultAddr = addresses.find((a) => a.isDefault);
      const defaultAddressId = defaultAddr ? defaultAddr._id : null;

      return res.json({
        message: "Address deleted.",
        addresses,
        defaultAddressId,
        defaultAddress: defaultAddr || null,
      });
    } catch (err) {
      console.error("DELETE /account/shipping/addresses/:id error:", err);
      return res.status(500).json({
        message: "Failed to delete address.",
      });
    }
  }
);

/**
 * POST /api/account/shipping/addresses/:id/set-default
 */
router.post(
  "/account/shipping/addresses/:id/set-default",
  authMiddleware,
  async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) {
        return res.status(401).json({ message: "Unauthorized" });
      }

      const { id } = req.params;
      if (!ObjectId.isValid(id)) {
        return res.status(400).json({ message: "Invalid address id" });
      }

      const existing = await ShippingAddresses.findOne({
        _id: new ObjectId(id),
        customerId: userId,
      });

      if (!existing) {
        return res.status(404).json({ message: "Address not found" });
      }

      const customerFilter = getCustomerFilter(userId);

      await ShippingAddresses.updateMany(customerFilter, {
        $set: { isDefault: false },
      });

      await ShippingAddresses.updateOne(
        { _id: new ObjectId(id) },
        { $set: { isDefault: true, updatedAt: new Date() } }
      );

      const addresses = await ShippingAddresses.find(customerFilter)
        .sort({ createdAt: -1 })
        .toArray();
      const defaultAddr = addresses.find((a) => a.isDefault);

      return res.json({
        message: "Default address updated.",
        defaultAddressId: id,
        defaultAddress: defaultAddr || null,
      });
    } catch (err) {
      console.error(
        "POST /account/shipping/addresses/:id/set-default error:",
        err
      );
      return res.status(500).json({
        message: "Failed to set default address.",
      });
    }
  }
);

router.get("/overview", authMiddleware, async (req, res) => {
  try {
    const userId = getUserId(req);
    const userOid = ObjectId.isValid(userId) ? new ObjectId(userId) : null;
    if (!userOid) {
      return res.status(401).json({ success: false, message: "Invalid customer session" });
    }

    const baseFilter = { userId: userOid };
    const [totalOrders, activeOrders, completedOrders, addressCount] =
      await Promise.all([
        Orders.countDocuments(baseFilter),
        Orders.countDocuments({
          ...baseFilter,
          status: { $nin: ACCOUNT_OVERVIEW_FINAL_STATUSES },
        }),
        Orders.countDocuments({
          ...baseFilter,
          status: { $in: ["delivered", "completed"] },
        }),
        ShippingAddresses.countDocuments(getCustomerFilter(userId)),
      ]);

    return res.json({
      success: true,
      data: {
        totalOrders,
        activeOrders,
        completedOrders,
        savedAddresses: addressCount,
      },
    });
  } catch (err) {
    console.error("GET /api/account/overview error:", err);
    return res
      .status(500)
      .json({ success: false, message: "Failed to load account overview" });
  }
});

export default router;
