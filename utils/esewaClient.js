// routes/esewaRoutes.js
import express from "express";
import { v4 as uuidv4 } from "uuid";
import { client } from "../dbConfig.js";
import { authMiddleware } from "../middlewares/authMiddleware.js";

const router = express.Router();
const dbName = process.env.DB_NAME || "glamzi_ecommerce";
const db = client.db(dbName);
const Orders = db.collection("orders");

/**
 * POST /api/payment/esewa/create-token
 * Body: { items: [...], addressId, amount }
 */
router.post("/create-token", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const { items, address, amount } = req.body;

    if (!amount || amount <= 0) {
      return res.status(400).json({ message: "Invalid amount" });
    }

    // Generate unique request_id for eSewa
    const requestId = `GLZ-${uuidv4().split("-")[0].toUpperCase()}`;

    // Create pending order
    const order = {
      userId,
      items,
      address,
      amount,
      paymentMethod: "esewa-token",
      paymentStatus: "PENDING",
      requestId,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await Orders.insertOne(order);

    return res.json({
      success: true,
      requestId,
      orderId: result.insertedId,
      amount,
    });
  } catch (err) {
    console.error("eSewa create-token error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});
// routes/esewaRoutes.js (continued)
import { callEsewa } from "../utils/esewaClient.js";

router.post("/status", authMiddleware, async (req, res) => {
  try {
    const { requestId } = req.body;
    if (!requestId) {
      return res.status(400).json({ message: "requestId required" });
    }

    const order = await Orders.findOne({ requestId });
    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    // body depends on eSewa docs; this is a sketch:
    const esewaResponse = await callEsewa("/api/epay/token/status", "POST", {
      request_id: requestId,
      amount: order.amount,
      // maybe transaction_code if required
    });

    // If SUCCESS, mark order as paid
    if (
      esewaResponse.response_code === 0 &&
      (esewaResponse.status === "SUCCESS" || esewaResponse.response_message === "success")
    ) {
      await Orders.updateOne(
        { _id: order._id },
        {
          $set: {
            paymentStatus: "PAID",
            esewaReference: esewaResponse.reference_code,
            updatedAt: new Date(),
          },
        }
      );
    }

    return res.json({
      success: true,
      esewaResponse,
    });
  } catch (err) {
    console.error("eSewa status error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});
