// routes/sellerMessageRoutes.js

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

const Conversations = db.collection("conversations");
const Messages = db.collection("messages");
const Users = db.collection("users");
const Orders = db.collection("orders");
const ProductViews = db.collection("productViews"); // adjust name if different

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

// ====== HELPER: ensure seller role ======
function requireSeller(req, res, next) {
  const user = req.user;
  if (!user || user.role !== "seller") {
    return res
      .status(403)
      .json({ message: "Seller access only. Please login as seller." });
  }
  next();
}

// ====== HELPER: build counterpart name for conversations ======
async function enrichConversationForSeller(conv) {
  const result = {
    _id: conv._id,
    type: conv.type || (conv.customerId ? "customer" : "admin"),
    lastMessageText: conv.lastMessageText || "",
    lastMessageAt: conv.lastMessageAt || conv.updatedAt || conv.createdAt,
    unreadForSeller: conv.unreadForSeller || 0,
    product: conv.product || null,
  };

  // Determine counterpart name
  if (result.type === "admin") {
    result.counterpartName = conv.counterpartName || "Glamzi Admin";
  } else if (result.type === "support") {
    result.counterpartName = conv.counterpartName || "Support Team";
  } else if (conv.customerName) {
    result.counterpartName = conv.customerName;
  } else if (conv.customerId) {
    try {
      const customer = await Users.findOne(
        { _id: new ObjectId(conv.customerId) },
        { projection: { name: 1, storeName: 1, email: 1 } }
      );
      result.counterpartName =
        customer?.name || customer?.storeName || customer?.email || "Customer";
    } catch {
      result.counterpartName = "Customer";
    }
  } else {
    result.counterpartName = conv.counterpartName || "Unknown";
  }

  return result;
}

// ====== GET /seller/dashboard/messages ======
// List all conversations for this seller
router.get(
  "/seller/dashboard/messages",
  authMiddleware,
  requireSeller,
  async (req, res) => {
    try {
      const sellerId = req.user.id;

      const docs = await Conversations.find({
        sellerId: new ObjectId(sellerId),
      })
        .sort({ updatedAt: -1 })
        .toArray();

      const conversations = [];
      for (const c of docs) {
        conversations.push(await enrichConversationForSeller(c));
      }

      return res.json({ conversations });
    } catch (err) {
      console.error("Error fetching seller conversations:", err);
      return res.status(500).json({ message: "Failed to load conversations" });
    }
  }
);

// ====== GET /seller/dashboard/messages/unread-count ======
// Total unread for this seller (for sidebar badge polling)
router.get(
  "/seller/dashboard/messages/unread-count",
  authMiddleware,
  requireSeller,
  async (req, res) => {
    try {
      const sellerId = req.user.id;

      const agg = await Conversations.aggregate([
        { $match: { sellerId: new ObjectId(sellerId) } },
        {
          $group: {
            _id: null,
            totalUnread: { $sum: { $ifNull: ["$unreadForSeller", 0] } },
          },
        },
      ]).toArray();

      const totalUnread = agg[0]?.totalUnread || 0;
      return res.json({ unreadCount: totalUnread });
    } catch (err) {
      console.error("Error computing unread count for seller:", err);
      return res.status(500).json({ message: "Failed to compute unread count" });
    }
  }
);

// ====== GET /seller/dashboard/messages/:id ======
// Fetch messages in a specific conversation
router.get(
  "/seller/dashboard/messages/:id",
  authMiddleware,
  requireSeller,
  async (req, res) => {
    try {
      const sellerId = req.user.id;
      const conversationId = req.params.id;

      const conv = await Conversations.findOne({
        _id: new ObjectId(conversationId),
        sellerId: new ObjectId(sellerId),
      });

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
        senderRole: m.senderRole,
        text: m.text,
        attachmentUrl: m.attachmentUrl || null,
        createdAt: m.createdAt,
      }));

      return res.json({ messages });
    } catch (err) {
      console.error("Error fetching seller messages:", err);
      return res.status(500).json({ message: "Failed to load messages" });
    }
  }
);

// ====== POST /seller/dashboard/messages/:id/mark-read ======
// Mark conversation as read for seller
router.post(
  "/seller/dashboard/messages/:id/mark-read",
  authMiddleware,
  requireSeller,
  async (req, res) => {
    try {
      const sellerId = req.user.id;
      const conversationId = req.params.id;

      const conv = await Conversations.findOne({
        _id: new ObjectId(conversationId),
        sellerId: new ObjectId(sellerId),
      });

      if (!conv) {
        return res.status(404).json({ message: "Conversation not found" });
      }

      await Conversations.updateOne(
        { _id: conv._id },
        {
          $set: {
            unreadForSeller: 0,
            updatedAt: new Date(),
          },
        }
      );

      // Recompute total unread for this seller
      const agg = await Conversations.aggregate([
        { $match: { sellerId: new ObjectId(sellerId) } },
        {
          $group: {
            _id: null,
            totalUnread: { $sum: { $ifNull: ["$unreadForSeller", 0] } },
          },
        },
      ]).toArray();

      const totalUnread = agg[0]?.totalUnread || 0;

      return res.json({
        success: true,
        unreadCount: totalUnread,
      });
    } catch (err) {
      console.error("Error marking conversation as read:", err);
      return res.status(500).json({ message: "Failed to mark as read" });
    }
  }
);

// ====== POST /seller/dashboard/messages/start ======
// Start new chat with Admin / Support
router.post(
  "/seller/dashboard/messages/start",
  authMiddleware,
  requireSeller,
  async (req, res) => {
    try {
      const sellerId = req.user.id;
      const { type } = req.body; // "admin" | "support"

      if (!type || !["admin", "support"].includes(type)) {
        return res.status(400).json({
          message: "Invalid type. Must be 'admin' or 'support'.",
        });
      }

      // Look for existing active conversation of this type
      const existing = await Conversations.findOne({
        sellerId: new ObjectId(sellerId),
        type,
        isClosed: { $ne: true },
      });

      if (existing) {
        return res.json({
          conversation: await enrichConversationForSeller(existing),
        });
      }

      const now = new Date();
      const counterpartName =
        type === "admin" ? "Glamzi Admin" : "Support Team";

      const insertResult = await Conversations.insertOne({
        sellerId: new ObjectId(sellerId),
        type,
        counterpartName,
        unreadForSeller: 0,
        unreadForAdmin: 0,
        unreadForSupport: 0,
        lastMessageText: "",
        lastMessageAt: null,
        createdAt: now,
        updatedAt: now,
        isClosed: false,
      });

      const newConv = await Conversations.findOne({
        _id: insertResult.insertedId,
      });

      return res.json({
        conversation: await enrichConversationForSeller(newConv),
      });
    } catch (err) {
      console.error("Error starting seller chat:", err);
      return res.status(500).json({ message: "Failed to start chat" });
    }
  }
);

// ====== POST /seller/dashboard/messages/:id ======
// Send message (text + optional attachment)
router.post(
  "/seller/dashboard/messages/:id",
  authMiddleware,
  requireSeller,
  upload.single("attachment"),
  async (req, res) => {
    try {
      const sellerId = req.user.id;
      const conversationId = req.params.id;
      const text = (req.body.text || "").trim();

      const conv = await Conversations.findOne({
        _id: new ObjectId(conversationId),
        sellerId: new ObjectId(sellerId),
      });

      if (!conv) {
        return res.status(404).json({ message: "Conversation not found" });
      }

      if (!text && !req.file) {
        return res
          .status(400)
          .json({ message: "Message must contain text or attachment" });
      }

      let attachmentUrl = null;
      if (req.file) {
        const baseUrl = `${req.protocol}://${req.get("host")}`;
        const relativePath = `/uploads/messages/${req.file.filename}`;
        attachmentUrl = `${baseUrl}${relativePath}`;
      }

      const now = new Date();

      const insertResult = await Messages.insertOne({
        conversationId: conv._id,
        sellerId: new ObjectId(sellerId),
        senderRole: "seller",
        text: text || null,
        attachmentUrl,
        createdAt: now,
      });

      // Determine unread field to bump (admin/support/customer)
      const updateFields = {
        lastMessageText: text || (attachmentUrl ? "📎 Attachment" : ""),
        lastMessageAt: now,
        updatedAt: now,
      };

      if (conv.type === "admin") {
        updateFields.unreadForAdmin = (conv.unreadForAdmin || 0) + 1;
      } else if (conv.type === "support") {
        updateFields.unreadForSupport = (conv.unreadForSupport || 0) + 1;
      } else {
        // default to customer conversation
        updateFields.unreadForCustomer = (conv.unreadForCustomer || 0) + 1;
      }

      await Conversations.updateOne(
        { _id: conv._id },
        { $set: updateFields }
      );

      const msg = await Messages.findOne({ _id: insertResult.insertedId });

      return res.json({
        message: {
          _id: msg._id,
          senderRole: msg.senderRole,
          text: msg.text,
          attachmentUrl: msg.attachmentUrl || null,
          createdAt: msg.createdAt,
        },
      });
    } catch (err) {
      console.error("Error sending seller message:", err);
      return res.status(500).json({ message: "Failed to send message" });
    }
  }
);

// ====== GET /seller/dashboard/messages/:id/customer-summary ======
// Customer info + orders + viewed items (for customer-type conversations)
router.get(
  "/seller/dashboard/messages/:id/customer-summary",
  authMiddleware,
  requireSeller,
  async (req, res) => {
    try {
      const sellerId = req.user.id;
      const conversationId = req.params.id;

      const conv = await Conversations.findOne({
        _id: new ObjectId(conversationId),
        sellerId: new ObjectId(sellerId),
      });

      if (!conv) {
        return res.status(404).json({ message: "Conversation not found" });
      }

      if (!conv.customerId) {
        return res.json({
          customer: null,
          orders: [],
          items: [],
        });
      }

      const customerId = conv.customerId;

      // --- Customer basic info ---
      const customer = await Users.findOne(
        { _id: new ObjectId(customerId) },
        {
          projection: {
            name: 1,
            email: 1,
            phone: 1,
            address: 1,
            shippingAddress: 1,
          },
        }
      );

      const customerSummary = customer
        ? {
            name: customer.name || "",
            email: customer.email || "",
            phone: customer.phone || "",
            address: customer.address || "",
            shippingAddress: customer.shippingAddress || "",
          }
        : null;

      // --- Orders from this customer to this seller ---
      const orderDocs = await Orders.find({
        customerId: new ObjectId(customerId),
        sellerId: new ObjectId(sellerId),
      })
        .sort({ createdAt: -1 })
        .limit(20)
        .toArray();

      const orders = orderDocs.map((o) => ({
        _id: o._id,
        orderNumber: o.orderNumber || null,
        createdAt: o.createdAt || null,
        itemCount: o.items?.length || o.itemCount || 0,
        total: o.total || o.totalAmount || 0,
        status: o.status || "Pending",
      }));

      // --- Items viewed (from your product view tracking) ---
      const viewDocs = await ProductViews.find({
        customerId: new ObjectId(customerId),
        sellerId: new ObjectId(sellerId),
      })
        .sort({ viewedAt: -1 })
        .limit(30)
        .toArray();

      const items = viewDocs.map((v) => ({
        _id: v.productId || v._id,
        productId: v.productId,
        title: v.title,
        price: v.price,
        imageUrl: v.imageUrl,
        viewedAt: v.viewedAt || v.createdAt,
      }));

      return res.json({
        customer: customerSummary,
        orders,
        items,
      });
    } catch (err) {
      console.error("Error fetching customer summary:", err);
      return res
        .status(500)
        .json({ message: "Failed to load customer summary" });
    }
  }
);

export default router;
