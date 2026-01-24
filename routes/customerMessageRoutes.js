// routes/customerMessageRoutes.js
import express from "express";
import dotenv from "dotenv";
import { ObjectId } from "mongodb";
import multer from "multer";

import { client } from "../dbConfig.js";
import { authMiddleware } from "../middlewares/authMiddleware.js";

dotenv.config();

const router = express.Router();

const dbName = process.env.DB_NAME || "glamzi_ecommerce";
const db = client.db(dbName);

const Users = db.collection("users");

// Customer ↔ Seller
const Conversations = db.collection("customerSellerConversations");
const Messages = db.collection("customerSellerMessages");

// Customer ↔ Support
const SupportConversations = db.collection("customerSupportConversations");
const SupportMessages = db.collection("customerSupportMessages");

// --- helpers -------------------------------------------------------

const toObjectId = (id) => {
  try {
    return new ObjectId(id);
  } catch {
    return null;
  }
};

async function getSellerPublicInfo(sellerId) {
  const oid = toObjectId(sellerId);
  if (!oid) return null;

  const seller = await Users.findOne({ _id: oid, role: "seller" });
  if (!seller) return null;

  return {
    sellerId: oid,
    storeName:
      seller.storeName ||
      seller.shopName ||
      seller.name ||
      seller.email ||
      "Seller",
    storeSlug: seller.storeSlug || seller.slug || null,
  };
}

async function getCustomerPublicInfo(customerOid) {
  const user = await Users.findOne({ _id: customerOid });
  if (!user) {
    return {
      customerName: "Customer",
      customerEmail: "",
      customerPhone: "",
    };
  }

  return {
    customerName:
      user.name || user.fullName || user.displayName || user.email || "Customer",
    customerEmail: user.email || "",
    customerPhone: user.phone || user.mobile || "",
  };
}

// Multer for attachments (seller + support)
const upload = multer({ dest: "uploads/messages" });

// ==================================================================
//  CUSTOMER ↔ SELLER CONVERSATIONS
// ==================================================================

// POST /api/customer/messages/start
// body: { sellerId, productId?, orderId?, source? }
router.post("/customer/messages/start", authMiddleware, async (req, res) => {
  try {
    const customerId = req.user.id;
    const { sellerId, productId, orderId, source } = req.body || {};

    if (!sellerId) {
      return res
        .status(400)
        .json({ success: false, message: "sellerId is required" });
    }

    const sellerInfo = await getSellerPublicInfo(sellerId);
    if (!sellerInfo) {
      return res
        .status(404)
        .json({ success: false, message: "Seller not found" });
    }

    const customerOid = toObjectId(customerId);
    if (!customerOid) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid customer id" });
    }

    // Try to reuse existing conversation for this customer + seller
    let conversation = await Conversations.findOne({
      customerId: customerOid,
      sellerId: sellerInfo.sellerId,
    });

    if (!conversation) {
      const now = new Date();
      const doc = {
        customerId: customerOid,
        sellerId: sellerInfo.sellerId,
        sellerName: sellerInfo.storeName,
        storeName: sellerInfo.storeName,
        storeSlug: sellerInfo.storeSlug || null,
        productId: productId ? toObjectId(productId) : null,
        orderId: orderId ? toObjectId(orderId) : null,
        source: source || "generic",
        lastMessageText: "",
        lastMessageAt: now,
        unreadForCustomer: 0,
        unreadForSeller: 0,
        createdAt: now,
        updatedAt: now,
      };

      const result = await Conversations.insertOne(doc);
      conversation = { _id: result.insertedId, ...doc };
    } else {
      // Hydrate old docs missing store info
      const needsUpdate =
        !conversation.sellerName ||
        !conversation.storeName ||
        !Object.prototype.hasOwnProperty.call(conversation, "storeSlug");

      if (needsUpdate) {
        await Conversations.updateOne(
          { _id: conversation._id },
          {
            $set: {
              sellerName: sellerInfo.storeName,
              storeName: sellerInfo.storeName,
              storeSlug: sellerInfo.storeSlug || null,
              updatedAt: new Date(),
            },
          }
        );
        conversation = {
          ...conversation,
          sellerName: sellerInfo.storeName,
          storeName: sellerInfo.storeName,
          storeSlug: sellerInfo.storeSlug || null,
        };
      }
    }

    return res.json({
      success: true,
      conversation,
    });
  } catch (err) {
    console.error("POST /customer/messages/start error:", err);
    res
      .status(500)
      .json({ success: false, message: "Failed to start conversation" });
  }
});

// GET /api/customer/messages
// → list all seller conversations for this customer, with sellerName/storeName
router.get("/customer/messages", authMiddleware, async (req, res) => {
  try {
    const customerId = req.user.id;
    const customerOid = toObjectId(customerId);
    if (!customerOid) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid customer id" });
    }

    const list = await Conversations.find({ customerId: customerOid })
      .sort({ updatedAt: -1 })
      .toArray();

    // Ensure storeName / slug hydrated for old docs
    const sellerIdsToHydrate = [];
    list.forEach((c) => {
      if (!c.sellerId) return;
      const needHydration =
        !c.sellerName ||
        !c.storeName ||
        !Object.prototype.hasOwnProperty.call(c, "storeSlug");
      if (needHydration) sellerIdsToHydrate.push(c.sellerId.toString());
    });

    if (sellerIdsToHydrate.length > 0) {
      const unique = [...new Set(sellerIdsToHydrate)];
      const oids = unique.map((id) => toObjectId(id)).filter(Boolean);

      const sellers = await Users.find({
        _id: { $in: oids },
        role: "seller",
      }).toArray();

      const map = {};
      sellers.forEach((s) => {
        map[s._id.toString()] = {
          storeName:
            s.storeName || s.shopName || s.name || s.email || "Seller",
          storeSlug: s.storeSlug || s.slug || null,
        };
      });

      for (const conv of list) {
        const key = conv.sellerId?.toString();
        if (key && map[key]) {
          conv.sellerName = conv.sellerName || map[key].storeName;
          conv.storeName = conv.storeName || map[key].storeName;
          if (!Object.prototype.hasOwnProperty.call(conv, "storeSlug")) {
            conv.storeSlug = map[key].storeSlug;
          }
        }
      }
    }

    res.json({
      success: true,
      conversations: list,
    });
  } catch (err) {
    console.error("GET /customer/messages error:", err);
    res
      .status(500)
      .json({ success: false, message: "Failed to load conversations" });
  }
});

// GET /api/customer/messages/:conversationId
router.get(
  "/customer/messages/:conversationId",
  authMiddleware,
  async (req, res) => {
    try {
      const customerId = req.user.id;
      const { conversationId } = req.params;

      const convId = toObjectId(conversationId);
      if (!convId) {
        return res
          .status(400)
          .json({ success: false, message: "Invalid conversation id" });
      }

      const conversation = await Conversations.findOne({ _id: convId });
      if (!conversation) {
        return res
          .status(404)
          .json({ success: false, message: "Conversation not found" });
      }

      if (conversation.customerId.toString() !== customerId) {
        return res
          .status(403)
          .json({ success: false, message: "Not allowed" });
      }

      const messages = await Messages.find({
        conversationId: convId,
      })
        .sort({ createdAt: 1 })
        .toArray();

      // Mark as read for customer
      await Messages.updateMany(
        {
          conversationId: convId,
          readByCustomer: { $ne: true },
        },
        { $set: { readByCustomer: true } }
      );
      await Conversations.updateOne(
        { _id: convId },
        { $set: { unreadForCustomer: 0 } }
      );

      res.json({
        success: true,
        messages,
      });
    } catch (err) {
      console.error("GET /customer/messages/:id error:", err);
      res
        .status(500)
        .json({ success: false, message: "Failed to load messages" });
    }
  }
);

// POST /api/customer/messages/:conversationId
// (customer sends message to seller)
router.post(
  "/customer/messages/:conversationId",
  authMiddleware,
  upload.single("attachment"),
  async (req, res) => {
    try {
      const customerId = req.user.id;
      const { conversationId } = req.params;
      const convId = toObjectId(conversationId);
      if (!convId) {
        return res
          .status(400)
          .json({ success: false, message: "Invalid conversation id" });
      }

      const conversation = await Conversations.findOne({ _id: convId });
      if (!conversation) {
        return res
          .status(404)
          .json({ success: false, message: "Conversation not found" });
      }
      if (conversation.customerId.toString() !== customerId) {
        return res
          .status(403)
          .json({ success: false, message: "Not allowed" });
      }

      const text = (req.body.text || "").trim();
      const file = req.file;

      if (!text && !file) {
        return res.status(400).json({
          success: false,
          message: "Message text or attachment is required",
        });
      }

      const now = new Date();
      const messageDoc = {
        conversationId: convId,
        senderRole: "customer",
        senderId: toObjectId(customerId),
        text: text || "",
        attachmentUrl: file ? `/uploads/messages/${file.filename}` : null,
        readByCustomer: true,
        readBySeller: false,
        createdAt: now,
      };

      const { insertedId } = await Messages.insertOne(messageDoc);
      const message = { _id: insertedId, ...messageDoc };

      await Conversations.updateOne(
        { _id: convId },
        {
          $set: {
            lastMessageText: text || (file ? "📎 Attachment" : ""),
            lastMessageAt: now,
            updatedAt: now,
          },
          $inc: { unreadForSeller: 1 },
        }
      );

      res.status(201).json({
        success: true,
        message,
      });
    } catch (err) {
      console.error("POST /customer/messages/:id error:", err);
      res
        .status(500)
        .json({ success: false, message: "Failed to send message" });
    }
  }
);

// ==================================================================
//  CUSTOMER ↔ SUPPORT MESSAGES  (used by MessageCenter as well)
// ==================================================================

// GET /api/customer/support/messages
router.get("/customer/support/messages", authMiddleware, async (req, res) => {
  try {
    const customerId = req.user.id;
    const customerOid = toObjectId(customerId);
    if (!customerOid) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid customer id" });
    }

    // Mark admin/support messages as read by customer
    await SupportMessages.updateMany(
      {
        customerId: customerOid,
        senderRole: { $in: ["admin", "support"] },
        readByCustomer: { $ne: true },
      },
      { $set: { readByCustomer: true } }
    );

    // Load messages (after marking read)
    const messages = await SupportMessages.find({
      customerId: customerOid,
    })
      .sort({ createdAt: 1 })
      .toArray();

    // Determine last message meta
    const last = messages[messages.length - 1] || null;
    const lastMessageText =
      (last && last.text) ||
      (last && last.attachmentUrl ? "📎 Attachment" : "") ||
      "";
    const lastMessageAt = last?.createdAt || null;

    // Hydrate customer info
    const customerInfo = await getCustomerPublicInfo(customerOid);

    const now = new Date();

    // Upsert support conversation record for this customer
    await SupportConversations.updateOne(
      { customerId: customerOid },
      {
        $setOnInsert: {
          customerId: customerOid,
          createdAt: now,
        },
        $set: {
          customerName: customerInfo.customerName,
          customerEmail: customerInfo.customerEmail,
          customerPhone: customerInfo.customerPhone,
          lastMessageText,
          lastMessageAt,
          updatedAt: now,
          unreadForCustomer: 0, // customer is viewing now
        },
      },
      { upsert: true }
    );

    res.json({
      success: true,
      messages,
    });
  } catch (err) {
    console.error("GET /customer/support/messages error:", err);
    res
      .status(500)
      .json({ success: false, message: "Failed to load support messages" });
  }
});

// POST /api/customer/support/messages
router.post(
  "/customer/support/messages",
  authMiddleware,
  upload.single("attachment"),
  async (req, res) => {
    try {
      const customerId = req.user.id;
      const customerOid = toObjectId(customerId);
      if (!customerOid) {
        return res
          .status(400)
          .json({ success: false, message: "Invalid customer id" });
      }

      const text = (req.body.text || "").trim();
      const file = req.file;

      if (!text && !file) {
        return res.status(400).json({
          success: false,
          message: "Message text or attachment is required",
        });
      }

      const now = new Date();
      const doc = {
        customerId: customerOid,
        senderRole: "customer",
        text: text || "",
        attachmentUrl: file ? `/uploads/messages/${file.filename}` : null,
        createdAt: now,
        readByCustomer: true,
        readByAdmin: false,
      };

      const { insertedId } = await SupportMessages.insertOne(doc);

      // Hydrate customer info
      const customerInfo = await getCustomerPublicInfo(customerOid);

      // Update / create conversation for this customer
      await SupportConversations.updateOne(
        { customerId: customerOid },
        {
          $setOnInsert: {
            customerId: customerOid,
            createdAt: now,
          },
          $set: {
            customerName: customerInfo.customerName,
            customerEmail: customerInfo.customerEmail,
            customerPhone: customerInfo.customerPhone,
            lastMessageText:
              doc.text || (doc.attachmentUrl ? "📎 Attachment" : ""),
            lastMessageAt: now,
            updatedAt: now,
          },
          $inc: {
            unreadForAdmin: 1, // admin hasn't seen this new message yet
          },
        },
        { upsert: true }
      );

      res.status(201).json({
        success: true,
        message: { _id: insertedId, ...doc },
      });
    } catch (err) {
      console.error("POST /customer/support/messages error:", err);
      res
        .status(500)
        .json({ success: false, message: "Failed to send support message" });
    }
  }
);

// POST /api/customer/support/messages/mark-read
// Mark all support messages as read for the logged-in customer
router.post(
  "/customer/support/messages/mark-read",
  authMiddleware,
  async (req, res) => {
    try {
      const customerId = req.user.id;
      const customerOid = toObjectId(customerId);
      if (!customerOid) {
        return res
          .status(400)
          .json({ success: false, message: "Invalid customer id" });
      }

      // 1) Mark all unread support messages as read for this customer
      const msgResult = await SupportMessages.updateMany(
        {
          customerId: customerOid,
          readByCustomer: { $ne: true },
        },
        {
          $set: { readByCustomer: true },
        }
      );

      // 2) Reset unreadForCustomer on the support conversation(s) for this customer
      const convResult = await SupportConversations.updateMany(
        { customerId: customerOid },
        {
          $set: {
            unreadForCustomer: 0,
            updatedAt: new Date(),
          },
        }
      );

      return res.json({
        success: true,
        updatedMessages: msgResult.modifiedCount || 0,
        updatedConversations: convResult.modifiedCount || 0,
      });
    } catch (err) {
      console.error(
        "POST /customer/support/messages/mark-read error:",
        err
      );
      return res.status(500).json({
        success: false,
        message: "Failed to mark support messages as read",
      });
    }
  }
);

export default router;
