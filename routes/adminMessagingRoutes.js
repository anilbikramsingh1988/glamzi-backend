// routes/adminMessagingRoutes.js

import express from "express";
import dotenv from "dotenv";
import { ObjectId } from "mongodb";

import { client } from "../dbConfig.js";
import {
  authMiddleware,
  isActiveMiddleware,
  isStaffMiddleware,
} from "../middlewares/authMiddleware.js";

dotenv.config();

const router = express.Router();

// ===== DB SETUP =====
const dbName = process.env.DB_NAME || "glamzi_ecommerce";
const db = client.db(dbName);

// 🔹 Customer ↔ Support collections (must match customerMessageRoutes)
const CustomerConversations = db.collection("customerSupportConversations");
const CustomerMessages = db.collection("customerSupportMessages");

// 🔹 Seller ↔ Admin/Support collections (shared with sellerMessageRoutes.js)
const Conversations = db.collection("conversations");
const Messages = db.collection("messages");
const Users = db.collection("users");

// ===== HELPERS =====

function ensureObjectId(id) {
  try {
    return new ObjectId(id);
  } catch {
    return null;
  }
}

const staffGuard = [authMiddleware, isActiveMiddleware, isStaffMiddleware];

// GET /api/admin/messages/unread-counts
// → total unread tickets for customer support vs seller support (for admin dashboard)
router.get("/messages/unread-counts", ...staffGuard, async (req, res) => {
  try {
    // ----- CUSTOMER SUPPORT UNREAD -----
    const [customerAgg] = await CustomerConversations.aggregate([
      {
        $group: {
          _id: null,
          totalUnread: { $sum: { $ifNull: ["$unreadForAdmin", 0] } },
        },
      },
    ]).toArray();

    // ----- SELLER SUPPORT UNREAD (admin + support types) -----
    const [sellerAgg] = await Conversations.aggregate([
      {
        $match: {
          type: { $in: ["admin", "support"] },
        },
      },
      {
        $group: {
          _id: null,
          totalUnread: {
            $sum: {
              $add: [
                { $ifNull: ["$unreadForAdmin", 0] },
                { $ifNull: ["$unreadForSupport", 0] },
              ],
            },
          },
        },
      },
    ]).toArray();

    const customerSupportUnread = customerAgg?.totalUnread || 0;
    const sellerSupportUnread = sellerAgg?.totalUnread || 0;

    return res.json({
      customerSupportUnread,
      sellerSupportUnread,
      totalSupportUnread: customerSupportUnread + sellerSupportUnread,
    });
  } catch (err) {
    console.error("Admin: error loading unread counts:", err);
    return res
      .status(500)
      .json({ message: "Failed to load support unread counts" });
  }
});

// ===============================
//   CUSTOMER SUPPORT ROUTES
//   /api/admin/messages/customers
// ===============================

/**
 * GET /api/admin/messages/customers
 * List customer support conversations for staff (admin, support, etc.)
 */
router.get("/messages/customers", ...staffGuard, async (req, res) => {
  try {
    const conversations = await CustomerConversations.find({})
      .sort({ lastMessageAt: -1, createdAt: -1 })
      .limit(500)
      .toArray();

    const mapped = conversations.map((c) => ({
      _id: c._id,
      customerId: c.customerId,
      customerName: c.customerName || "Customer",
      customerEmail: c.customerEmail || "",
      customerPhone: c.customerPhone || "",
      lastMessageText: c.lastMessageText || "",
      lastMessageAt: c.lastMessageAt || c.updatedAt || c.createdAt,
      unreadForAdmin: c.unreadForAdmin || 0,
    }));

    return res.json({ conversations: mapped });
  } catch (err) {
    console.error("Admin: error loading customer conversations:", err);
    return res
      .status(500)
      .json({ message: "Failed to load conversations" });
  }
});

/**
 * GET /api/admin/messages/customers/:id
 * Load all support messages in a specific customer conversation.
 * Conversation ID comes from customerSupportConversations._id
 */
router.get("/messages/customers/:id", ...staffGuard, async (req, res) => {
  try {
    const { id } = req.params;
    const convId = ensureObjectId(id);
    if (!convId) {
      return res.status(400).json({ message: "Invalid conversation id" });
    }

    const conv = await CustomerConversations.findOne({ _id: convId });
    if (!conv) {
      return res.status(404).json({ message: "Conversation not found" });
    }

    // 🔹 Messages are linked by customerId (per customerMessageRoutes)
    const messages = await CustomerMessages.find({
      customerId: conv.customerId,
    })
      .sort({ createdAt: 1 })
      .toArray();

    // Normalize role fields for frontend:
    // CustomerSupport.jsx uses: msg.senderType || msg.fromRole
    const mapped = messages.map((m) => {
      const role = m.senderRole || m.fromRole || m.senderType || "customer";
      return {
        _id: m._id,
        text: m.text || "",
        createdAt: m.createdAt,
        senderRole: role, // new
        senderType: role, // for frontend
        fromRole: role, // for older code
      };
    });

    const now = new Date();

    // Mark messages as read for admin
    await CustomerMessages.updateMany(
      {
        customerId: conv.customerId,
        readByAdmin: { $ne: true },
      },
      { $set: { readByAdmin: true } }
    );

    // Reset unreadForAdmin in conversation
    await CustomerConversations.updateOne(
      { _id: conv._id },
      { $set: { unreadForAdmin: 0, updatedAt: now } }
    );

    return res.json({
      conversation: {
        _id: conv._id,
        customerId: conv.customerId,
        customerName: conv.customerName || "Customer",
        customerEmail: conv.customerEmail || "",
        customerPhone: conv.customerPhone || "",
      },
      messages: mapped,
    });
  } catch (err) {
    console.error("Admin: error loading customer messages:", err);
    return res.status(500).json({ message: "Failed to load messages" });
  }
});

/**
 * POST /api/admin/messages/customers/:id/reply
 * Body: { text }
 * Admin replies to a customer support conversation.
 */
router.post(
  "/messages/customers/:id/reply",
  ...staffGuard,
  async (req, res) => {
    try {
      const { id } = req.params;
      const { text } = req.body;

      const convId = ensureObjectId(id);
      if (!convId) {
        return res.status(400).json({ message: "Invalid conversation id" });
      }

      const trimmed = (text || "").trim();
      if (!trimmed) {
        return res.status(400).json({ message: "Reply text is required" });
      }

      const conv = await CustomerConversations.findOne({ _id: convId });
      if (!conv) {
        return res.status(404).json({ message: "Conversation not found" });
      }

      const now = new Date();

      // 🔹 Insert message linked by customerId
      const msgDoc = {
        customerId: conv.customerId,
        senderRole: "admin",
        fromRole: "admin", // keep for older frontend checks
        text: trimmed,
        createdAt: now,
        readByAdmin: true,
        readByCustomer: false,
      };

      const insertResult = await CustomerMessages.insertOne(msgDoc);

      const msg = {
        _id: insertResult.insertedId,
        ...msgDoc,
      };

      // Update conversation (last message + unreadForCustomer++)
      await CustomerConversations.updateOne(
        { _id: conv._id },
        {
          $set: {
            lastMessageText: trimmed,
            lastMessageAt: now,
            updatedAt: now,
          },
          $inc: {
            unreadForCustomer: 1,
          },
        }
      );

      return res.json({
        message: "Reply sent",
        data: msg,
      });
    } catch (err) {
      console.error("Admin: error sending customer reply:", err);
      return res.status(500).json({ message: "Failed to send message" });
    }
  }
);

// ===============================
//   SELLER SUPPORT ROUTES
//   /api/admin/messages/sellers
//   (aligned with sellerMessageRoutes.js)
// ===============================

/**
 * GET /api/admin/messages/sellers
 * List seller support conversations (type: "admin" | "support").
 * Uses shared "conversations" collection used by sellerMessageRoutes.js.
 */
router.get("/messages/sellers", ...staffGuard, async (req, res) => {
  try {
    const conversations = await Conversations.find({
      type: { $in: ["admin", "support"] },
    })
      .sort({ lastMessageAt: -1, createdAt: -1 })
      .limit(500)
      .toArray();

    // Hydrate seller info from users collection
    const sellerIdStrings = [
      ...new Set(
        conversations
          .map((c) => (c.sellerId ? c.sellerId.toString() : null))
          .filter(Boolean)
      ),
    ];

    let sellerMap = {};
    if (sellerIdStrings.length > 0) {
      const sellerOids = sellerIdStrings.map((id) => new ObjectId(id));
      const sellers = await Users.find(
        { _id: { $in: sellerOids }, role: "seller" },
        {
          projection: {
            name: 1,
            email: 1,
            phone: 1,
            storeName: 1,
            shopName: 1,
          },
        }
      ).toArray();

      sellerMap = sellers.reduce((acc, s) => {
        acc[s._id.toString()] = s;
        return acc;
      }, {});
    }

    const mapped = conversations.map((c) => {
      const key = c.sellerId ? c.sellerId.toString() : null;
      const seller = key ? sellerMap[key] : null;

      const sellerName =
        c.sellerName ||
        c.storeName ||
        seller?.storeName ||
        seller?.shopName ||
        seller?.name ||
        seller?.email ||
        "Seller";

      const sellerEmail = c.sellerEmail || seller?.email || "";
      const sellerPhone = c.sellerPhone || seller?.phone || "";

      // For 'admin' type, unread is unreadForAdmin; for 'support', unreadForSupport
      const unreadForAdminCount =
        c.type === "support"
          ? c.unreadForSupport || 0
          : c.unreadForAdmin || 0;

      return {
        _id: c._id,
        sellerId: c.sellerId,
        sellerName,
        sellerEmail,
        sellerPhone,
        lastMessageText: c.lastMessageText || "",
        lastMessageAt: c.lastMessageAt || c.updatedAt || c.createdAt,
        unreadForAdmin: unreadForAdminCount,
      };
    });

    return res.json({ conversations: mapped });
  } catch (err) {
    console.error("Admin: error loading seller conversations:", err);
    return res
      .status(500)
      .json({ message: "Failed to load seller conversations" });
  }
});

/**
 * GET /api/admin/messages/sellers/:id
 * Load messages in a specific seller support conversation.
 * Uses "conversations" + "messages" collections.
 */
router.get("/messages/sellers/:id", ...staffGuard, async (req, res) => {
  try {
    const { id } = req.params;
    const convId = ensureObjectId(id);
    if (!convId) {
      return res.status(400).json({ message: "Invalid conversation id" });
    }

    const conv = await Conversations.findOne({ _id: convId });
    if (!conv) {
      return res.status(404).json({ message: "Conversation not found" });
    }

    const msgs = await Messages.find({
      conversationId: conv._id,
    })
      .sort({ createdAt: 1 })
      .toArray();

    const messages = msgs.map((m) => ({
      _id: m._id,
      senderRole: m.senderRole || m.fromRole, // "seller" | "admin" | "support"
      text: m.text || "",
      attachmentUrl: m.attachmentUrl || null,
      createdAt: m.createdAt,
    }));

    // Reset unread for admin/support depending on conversation type
    const now = new Date();
    const unreadField = conv.type === "support" ? "unreadForSupport" : "unreadForAdmin";

    await Conversations.updateOne(
      { _id: conv._id },
      {
        $set: {
          [unreadField]: 0,
          updatedAt: now,
        },
      }
    );

    return res.json({ messages });
  } catch (err) {
    console.error("Admin: error loading seller messages:", err);
    return res.status(500).json({ message: "Failed to load messages" });
  }
});

/**
 * POST /api/admin/messages/sellers/:id/reply
 * Body: { text }
 * Admin replies to a seller conversation.
 * SellerSupport.jsx expects `res.data.data` to be the message object.
 */
router.post(
  "/messages/sellers/:id/reply",
  ...staffGuard,
  async (req, res) => {
    try {
      const { id } = req.params;
      const { text } = req.body;

      const convId = ensureObjectId(id);
      if (!convId) {
        return res.status(400).json({ message: "Invalid conversation id" });
      }

      const trimmed = (text || "").trim();
      if (!trimmed) {
        return res.status(400).json({ message: "Reply text is required" });
      }

      const conv = await Conversations.findOne({ _id: convId });
      if (!conv) {
        return res.status(404).json({ message: "Conversation not found" });
      }

      const now = new Date();

      const insertResult = await Messages.insertOne({
        conversationId: conv._id,
        sellerId: conv.sellerId,
        senderRole: "admin",
        text: trimmed,
        createdAt: now,
      });

      const msg = await Messages.findOne({
        _id: insertResult.insertedId,
      });

      // Update conversation: last message & unread for seller
      await Conversations.updateOne(
        { _id: conv._id },
        {
          $set: {
            lastMessageText: trimmed,
            lastMessageAt: now,
            updatedAt: now,
          },
          $inc: {
            unreadForSeller: 1,
          },
        }
      );

      return res.json({
        message: "Reply sent",
        data: {
          _id: msg._id,
          senderRole: msg.senderRole,
          text: msg.text,
          createdAt: msg.createdAt,
        },
      });
    } catch (err) {
      console.error("Admin: error sending seller reply:", err);
      return res.status(500).json({ message: "Failed to send message" });
    }
  }
);

export default router;
