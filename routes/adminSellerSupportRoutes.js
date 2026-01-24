// routes/adminSellerSupportRoutes.js
import express from "express";
import multer from "multer";
import path from "path";
import { fileURLToPath } from "url";
import { ObjectId } from "mongodb";
import dotenv from "dotenv";

dotenv.config();

import { client } from "../dbConfig.js";
import {
  authMiddleware,
  isStaffMiddleware, // admin / super-admin / account / marketing
} from "../middlewares/authMiddleware.js";

const router = express.Router();

// ================== FILE UPLOAD (attachments) ==================

// Fix __dirname in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Store attachments under /uploads/messages (same as seller side)
const storage = multer.diskStorage({
  destination(req, file, cb) {
    cb(null, path.join(__dirname, "..", "uploads", "messages"));
  },
  filename(req, file, cb) {
    const ext = path.extname(file.originalname);
    const base = path.basename(file.originalname, ext);
    cb(
      null,
      `${base}-${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`
    );
  },
});

const upload = multer({ storage });

// ================== DB COLLECTIONS ==================
// ✅ FIXED: Use the SAME collections as seller side for alignment
const dbName = process.env.DB_NAME || "glamzi_ecommerce";
const db = client.db(dbName);

const conversationsCol = db.collection("conversations"); // ✅ Same as seller side
const messagesCol = db.collection("messages"); // ✅ Same as seller side
const Users = db.collection("users"); // For looking up seller names
// (We don't need users/orders/productViews here; that’s for seller summary UI)

// Helper to normalize unreadForAdmin field
const getUnreadForAdmin = (conv) =>
  typeof conv.unreadForAdmin === "number" ? conv.unreadForAdmin : 0;

// ✅ Helper to look up seller name from Users collection
async function getSellerName(sellerId) {
  if (!sellerId) return "Unknown Seller";
  try {
    const sellerOid = sellerId instanceof ObjectId ? sellerId : new ObjectId(sellerId);
    const seller = await Users.findOne(
      { _id: sellerOid },
      { projection: { storeName: 1, name: 1, ownerFirstName: 1, ownerLastName: 1, email: 1 } }
    );
    if (!seller) return "Unknown Seller";
    return (
      seller.storeName ||
      seller.name ||
      `${seller.ownerFirstName || ""} ${seller.ownerLastName || ""}`.trim() ||
      seller.email ||
      "Seller"
    );
  } catch {
    return "Unknown Seller";
  }
}

// ================== ROUTES ==================

/**
 * GET /api/admin/messages/sellers
 *
 * 👉 List ALL seller ↔ admin/support conversations
 *    (type: "admin" | "support")
 */
router.get(
  "/messages/sellers",
  authMiddleware,
  isStaffMiddleware,
  async (req, res, next) => {
    try {
      const convs = await conversationsCol
        .find({
          type: { $in: ["admin", "support"] },
        })
        .sort({ updatedAt: -1 })
        .toArray();

      // ✅ Enrich with seller names from Users collection
      // Priority: Look up seller from DB first if sellerId exists, then fallback to stored fields
      const conversations = await Promise.all(
        convs.map(async (c) => {
          let sellerName = "Unknown Seller";
          if (c.sellerId) {
            // Always look up fresh seller name from Users collection
            sellerName = await getSellerName(c.sellerId);
          } else if (c.sellerName) {
            sellerName = c.sellerName;
          }
          return {
            _id: c._id,
            type: c.type || "admin",
            sellerId: c.sellerId || null,
            sellerName,
            lastMessageText: c.lastMessageText || "",
            lastMessageAt: c.lastMessageAt || c.updatedAt || c.createdAt,
            unreadForAdmin: getUnreadForAdmin(c),
          };
        })
      );

      // Total unread for all seller-support conversations
      const totalUnread = conversations.reduce(
        (sum, c) => sum + getUnreadForAdmin(c),
        0
      );

      res.json({ conversations, totalUnread });
    } catch (err) {
      console.error("Error listing seller conversations for admin:", err);
      next(err);
    }
  }
);

/**
 * GET /api/admin/messages/sellers/:conversationId
 *
 * 👉 Get full message history of a single seller conversation
 */
router.get(
  "/messages/sellers/:conversationId",
  authMiddleware,
  isStaffMiddleware,
  async (req, res, next) => {
    try {
      const { conversationId } = req.params;

      if (!ObjectId.isValid(conversationId)) {
        return res.status(400).json({ message: "Invalid conversation id" });
      }

      const convo = await conversationsCol.findOne({
        _id: new ObjectId(conversationId),
        type: { $in: ["admin", "support"] },
      });

      if (!convo) {
        return res.status(404).json({ message: "Conversation not found" });
      }

      const msgs = await messagesCol
        .find({ conversationId: new ObjectId(conversationId) })
        .sort({ createdAt: 1 })
        .toArray();

      const messages = msgs.map((m) => ({
        _id: m._id,
        senderRole: m.senderRole, // "seller" | "admin" | "support"
        text: m.text || "",
        attachmentUrl: m.attachmentUrl || null,
        createdAt: m.createdAt,
      }));

      // ✅ Look up seller name from Users collection
      // Priority: Look up from DB first if sellerId exists
      let sellerName = "Unknown Seller";
      if (convo.sellerId) {
        sellerName = await getSellerName(convo.sellerId);
      } else if (convo.sellerName) {
        sellerName = convo.sellerName;
      }

      res.json({
        conversation: {
          _id: convo._id,
          type: convo.type,
          sellerId: convo.sellerId,
          sellerName,
          lastMessageText: convo.lastMessageText || "",
          lastMessageAt: convo.lastMessageAt || convo.updatedAt || convo.createdAt,
          unreadForAdmin: getUnreadForAdmin(convo),
        },
        messages,
      });
    } catch (err) {
      console.error("Error loading seller conversation messages for admin:", err);
      next(err);
    }
  }
);

/**
 * POST /api/admin/messages/sellers/:conversationId/reply
 *
 * 👉 Admin/support replies to a seller
 * Body: text (optional) + multipart file "attachment" (optional)
 */
router.post(
  "/messages/sellers/:conversationId/reply",
  authMiddleware,
  isStaffMiddleware,
  upload.single("attachment"),
  async (req, res, next) => {
    try {
      const { conversationId } = req.params;
      const { text } = req.body;

      if (!ObjectId.isValid(conversationId)) {
        return res.status(400).json({ message: "Invalid conversation id" });
      }

      const convo = await conversationsCol.findOne({
        _id: new ObjectId(conversationId),
        type: { $in: ["admin", "support"] },
      });

      if (!convo) {
        return res.status(404).json({ message: "Conversation not found" });
      }

      if (!text && !req.file) {
        return res
          .status(400)
          .json({ message: "Text or attachment is required" });
      }

      const now = new Date();
      let attachmentUrl = null;

      if (req.file) {
        attachmentUrl = `/uploads/messages/${req.file.filename}`;
      }

      // Decide senderRole: "admin" or "support"
      const role = (req.user?.role || "").toLowerCase();
      const senderRole = role === "support" ? "support" : "admin";

      const messageDoc = {
        conversationId: new ObjectId(conversationId),
        senderRole, // "admin" | "support"
        text: text || "",
        attachmentUrl,
        createdAt: now,
      };

      const insertRes = await messagesCol.insertOne(messageDoc);

      const lastMessageText =
        text || (attachmentUrl ? "📎 Attachment" : "New message from admin");

      // Update convo: last message + increment unread for seller
      await conversationsCol.updateOne(
        { _id: convo._id },
        {
          $set: {
            lastMessageText,
            lastMessageAt: now,
            updatedAt: now,
          },
          $inc: {
            unreadForSeller: 1,
          },
        }
      );

      const saved = await messagesCol.findOne({ _id: insertRes.insertedId });

      res.json({ message: saved });
    } catch (err) {
      console.error("Error sending admin reply to seller:", err);
      next(err);
    }
  }
);

/**
 * POST /api/admin/messages/sellers/:conversationId/mark-read
 *
 * 👉 Mark a seller-support conversation as read for the ADMIN side.
 *    Returns total unread for all seller-support convos.
 */
router.post(
  "/messages/sellers/:conversationId/mark-read",
  authMiddleware,
  isStaffMiddleware,
  async (req, res, next) => {
    try {
      const { conversationId } = req.params;

      if (!ObjectId.isValid(conversationId)) {
        return res.status(400).json({ message: "Invalid conversation id" });
      }

      const convo = await conversationsCol.findOne({
        _id: new ObjectId(conversationId),
        type: { $in: ["admin", "support"] },
      });

      if (!convo) {
        return res.status(404).json({ message: "Conversation not found" });
      }

      // Clear unreadForAdmin for this conversation
      await conversationsCol.updateOne(
        { _id: convo._id },
        { $set: { unreadForAdmin: 0 } }
      );

      // Recompute total unread for admin across ALL seller-support convos
      const allConvs = await conversationsCol
        .find({ type: { $in: ["admin", "support"] } })
        .project({ unreadForAdmin: 1 })
        .toArray();

      const unreadCount = allConvs.reduce(
        (sum, c) => sum + getUnreadForAdmin(c),
        0
      );

      res.json({ success: true, unreadCount });
    } catch (err) {
      console.error("Error marking seller conversation read for admin:", err);
      next(err);
    }
  }
);

export default router;
