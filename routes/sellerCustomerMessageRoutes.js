// routes/sellerCustomerMessageRoutes.js

import express from "express";
import dotenv from "dotenv";
import multer from "multer";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { ObjectId } from "mongodb";

import { client } from "../dbConfig.js";
import { authMiddleware } from "../middlewares/authMiddleware.js";

dotenv.config();

const router = express.Router();

// ====== DB SETUP ======
const dbName = process.env.DB_NAME || "glamzi_ecommerce";
const db = client.db(dbName);

/**
 * IMPORTANT:
 * These are the SAME collections used in customerMessageRoutes.js
 * for customer ↔ seller chat.
 */
const Conversations = db.collection("customerSellerConversations");
const Messages = db.collection("customerSellerMessages");
const Users = db.collection("users");

// ====== ESM __dirname FIX ======
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ====== MULTER STORAGE FOR ATTACHMENTS ======
const messageUploadsDir = path.join(__dirname, "../uploads/messages");

if (!fs.existsSync(messageUploadsDir)) {
  fs.mkdirSync(messageUploadsDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, messageUploadsDir);
  },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname) || "";
    const base = path.basename(file.originalname, ext).replace(/\s+/g, "_");
    cb(null, `${Date.now()}_${base}${ext}`);
  },
});

const upload = multer({ storage });

// ====== HELPERS ======
function toObjectId(id) {
  try {
    return new ObjectId(id);
  } catch {
    return null;
  }
}

function requireSeller(req, res, next) {
  const user = req.user;
  if (!user || user.role !== "seller") {
    return res
      .status(403)
      .json({ message: "Seller access only. Please login as seller." });
  }
  next();
}

/**
 * Enrich a customerSellerConversation for seller UI
 * - Adds customer name/email if possible
 */
async function enrichConversationForSeller(conv) {
  const base = {
    _id: conv._id,
    customerId: conv.customerId,
    sellerId: conv.sellerId,
    lastMessageText: conv.lastMessageText || "",
    lastMessageAt: conv.lastMessageAt || conv.updatedAt || conv.createdAt,
    unreadForSeller: conv.unreadForSeller || 0,
    productId: conv.productId || null,
    orderId: conv.orderId || null,
    source: conv.source || "generic",
  };

  // We may later store customerName directly on the conversation.
  // For now, we can enrich via users collection if customerId exists.
  let customerName = conv.customerName || "";
  let customerEmail = conv.customerEmail || "";
  let customerPhone = conv.customerPhone || "";

  if (!customerName && conv.customerId) {
    try {
      const customer = await Users.findOne(
        { _id: conv.customerId },
        {
          projection: {
            name: 1,
            email: 1,
            phone: 1,
          },
        }
      );

      if (customer) {
        customerName = customer.name || "";
        customerEmail = customer.email || "";
        customerPhone = customer.phone || "";
      }
    } catch (e) {
      // ignore enrichment error
    }
  }

  return {
    ...base,
    customerName: customerName || "Customer",
    customerEmail: customerEmail || "",
    customerPhone: customerPhone || "",
  };
}

// ==================================================================
//  SELLER VIEW OF CUSTOMER ↔ SELLER CONVERSATIONS
//  All of this sits on top of customerSellerConversations/messages
// ==================================================================

/**
 * GET /api/seller/dashboard/customer-messages
 * List all conversations for this seller with customers
 */
router.get(
  "/seller/dashboard/customer-messages",
  authMiddleware,
  requireSeller,
  async (req, res) => {
    try {
      const sellerId = req.user.id;
      const sellerOid = toObjectId(sellerId);
      if (!sellerOid) {
        return res.status(400).json({ message: "Invalid seller id" });
      }

      const docs = await Conversations.find({ sellerId: sellerOid })
        .sort({ updatedAt: -1, createdAt: -1 })
        .toArray();

      const conversations = [];
      for (const c of docs) {
        conversations.push(await enrichConversationForSeller(c));
      }

      return res.json({
        success: true,
        conversations,
      });
    } catch (err) {
      console.error(
        "GET /seller/dashboard/customer-messages error:",
        err
      );
      return res
        .status(500)
        .json({ success: false, message: "Failed to load conversations" });
    }
  }
);

/**
 * GET /api/seller/dashboard/customer-messages/unread-count
 * Total unread messages from customers for this seller
 */
router.get(
  "/seller/dashboard/customer-messages/unread-count",
  authMiddleware,
  requireSeller,
  async (req, res) => {
    try {
      const sellerId = req.user.id;
      const sellerOid = toObjectId(sellerId);
      if (!sellerOid) {
        return res.status(400).json({ message: "Invalid seller id" });
      }

      const agg = await Conversations.aggregate([
        { $match: { sellerId: sellerOid } },
        {
          $group: {
            _id: null,
            totalUnread: { $sum: { $ifNull: ["$unreadForSeller", 0] } },
          },
        },
      ]).toArray();

      const unreadCount = agg[0]?.totalUnread || 0;

      return res.json({
        success: true,
        unreadCount,
      });
    } catch (err) {
      console.error(
        "GET /seller/dashboard/customer-messages/unread-count error:",
        err
      );
      return res
        .status(500)
        .json({ success: false, message: "Failed to compute unread count" });
    }
  }
);

/**
 * GET /api/seller/dashboard/customer-messages/:id
 * Fetch all messages of one conversation (customer ↔ seller)
 */
router.get(
  "/seller/dashboard/customer-messages/:id",
  authMiddleware,
  requireSeller,
  async (req, res) => {
    try {
      const sellerId = req.user.id;
      const sellerOid = toObjectId(sellerId);
      const conversationId = req.params.id;
      const convOid = toObjectId(conversationId);

      if (!sellerOid || !convOid) {
        return res.status(400).json({ message: "Invalid ids" });
      }

      const conversation = await Conversations.findOne({
        _id: convOid,
        sellerId: sellerOid,
      });

      if (!conversation) {
        return res
          .status(404)
          .json({ success: false, message: "Conversation not found" });
      }

      const msgs = await Messages.find({
        conversationId: convOid,
      })
        .sort({ createdAt: 1 })
        .toArray();

      const messages = msgs.map((m) => ({
        _id: m._id,
        senderRole: m.senderRole, // "customer" | "seller"
        text: m.text || "",
        attachmentUrl: m.attachmentUrl || null,
        createdAt: m.createdAt,
        readByCustomer: m.readByCustomer ?? false,
        readBySeller: m.readBySeller ?? false,
      }));

      // Mark as read for seller
      await Messages.updateMany(
        {
          conversationId: convOid,
          readBySeller: { $ne: true },
        },
        { $set: { readBySeller: true } }
      );

      await Conversations.updateOne(
        { _id: convOid },
        {
          $set: {
            unreadForSeller: 0,
            updatedAt: new Date(),
          },
        }
      );

      return res.json({
        success: true,
        messages,
      });
    } catch (err) {
      console.error(
        "GET /seller/dashboard/customer-messages/:id error:",
        err
      );
      return res
        .status(500)
        .json({ success: false, message: "Failed to load messages" });
    }
  }
);

/**
 * POST /api/seller/dashboard/customer-messages/:id
 * Seller sends a message to customer in an existing conversation
 * Body: text (optional) + attachment (optional)
 */
router.post(
  "/seller/dashboard/customer-messages/:id",
  authMiddleware,
  requireSeller,
  upload.single("attachment"),
  async (req, res) => {
    try {
      const sellerId = req.user.id;
      const sellerOid = toObjectId(sellerId);
      const conversationId = req.params.id;
      const convOid = toObjectId(conversationId);

      if (!sellerOid || !convOid) {
        return res.status(400).json({ message: "Invalid ids" });
      }

      const conversation = await Conversations.findOne({
        _id: convOid,
        sellerId: sellerOid,
      });

      if (!conversation) {
        return res
          .status(404)
          .json({ success: false, message: "Conversation not found" });
      }

      const text = (req.body.text || "").trim();
      const file = req.file;

      if (!text && !file) {
        return res.status(400).json({
          success: false,
          message: "Message text or attachment is required",
        });
      }

      let attachmentUrl = null;
      if (file) {
        const baseUrl = `${req.protocol}://${req.get("host")}`;
        const relativePath = `/uploads/messages/${file.filename}`;
        attachmentUrl = `${baseUrl}${relativePath}`;
      }

      const now = new Date();
      const messageDoc = {
        conversationId: convOid,
        senderRole: "seller",
        senderId: sellerOid,
        text: text || "",
        attachmentUrl,
        readByCustomer: false,
        readBySeller: true,
        createdAt: now,
      };

      const { insertedId } = await Messages.insertOne(messageDoc);
      const message = { _id: insertedId, ...messageDoc };

      await Conversations.updateOne(
        { _id: convOid },
        {
          $set: {
            lastMessageText:
              text || (attachmentUrl ? "📎 Attachment" : ""),
            lastMessageAt: now,
            updatedAt: now,
          },
          $inc: {
            unreadForCustomer: 1,
          },
        }
      );

      return res.status(201).json({
        success: true,
        message,
      });
    } catch (err) {
      console.error(
        "POST /seller/dashboard/customer-messages/:id error:",
        err
      );
      return res
        .status(500)
        .json({ success: false, message: "Failed to send message" });
    }
  }
);

export default router;
