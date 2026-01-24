// routes/paymentEsewaRoutes.js
import express from "express";
import dotenv from "dotenv";
import crypto from "crypto";
import { ObjectId } from "mongodb";

import { client } from "../dbConfig.js";
import { authMiddleware } from "../middlewares/authMiddleware.js";

dotenv.config();

const router = express.Router();
const db = client.db(process.env.DB_NAME || "glamzi_ecommerce");
const Orders = db.collection("orders");
const Invoices = db.collection("invoices");

// ========= CONFIG =========
const {
  ESEWA_ENV,
  ESEWA_MERCHANT_CODE,
  ESEWA_SECRET_KEY,
  ESEWA_SUCCESS_URL,
  ESEWA_FAILURE_URL,
  ESEWA_WEBHOOK_TOKEN,
  // Token-based integration (Bearer or Basic)
  ESEWA_TOKEN_BEARER,
  ESEWA_TOKEN_BASIC_USER,
  ESEWA_TOKEN_BASIC_PASS,
} = process.env;

// eSewa ePay v2 endpoints
const ESEWA_ENDPOINT =
  ESEWA_ENV === "production"
    ? "https://epay.esewa.com.np/api/epay/main/v2/form"
    : "https://rc-epay.esewa.com.np/api/epay/main/v2/form";

// eSewa transaction status check endpoint
const ESEWA_STATUS_ENDPOINT =
  ESEWA_ENV === "production"
    ? "https://epay.esewa.com.np/api/epay/transaction/status/"
    : "https://rc-epay.esewa.com.np/api/epay/transaction/status/";

// Generate HMAC-SHA256 signature for ePay v2
function generateEsewaSignature(message, secretKey) {
  const hmac = crypto.createHmac("sha256", secretKey);
  hmac.update(message);
  return hmac.digest("base64");
}

// ========= MIDDLEWARE: verify eSewa callback auth =========
function verifyEsewaCallbackAuth(req, res, next) {
  const authHeader = req.headers["authorization"] || "";
  if (!authHeader.startsWith("Bearer ")) {
    return res.status(401).json({
      response_code: 1,
      response_message: "Unauthorized: missing bearer token",
    });
  }

  const token = authHeader.slice("Bearer ".length).trim();

  if (!ESEWA_WEBHOOK_TOKEN) {
    console.warn(
      "⚠️ ESEWA_WEBHOOK_TOKEN is not set. All callbacks will be rejected."
    );
    return res.status(500).json({
      response_code: 1,
      response_message: "Server config error",
    });
  }

  if (token !== ESEWA_WEBHOOK_TOKEN) {
    return res.status(401).json({
      response_code: 1,
      response_message: "Unauthorized: invalid token",
    });
  }

  next();
}

// ========= MIDDLEWARE: verify eSewa token-based auth (Bearer or Basic) =========
function verifyEsewaTokenAuth(req, res, next) {
  const authHeader = req.headers["authorization"] || "";

  // Bearer
  if (authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice("Bearer ".length).trim();
    if (ESEWA_TOKEN_BEARER && token === ESEWA_TOKEN_BEARER) {
      return next();
    }
    return res.status(401).json({
      response_code: 1,
      response_message: "Unauthorized: invalid bearer token",
    });
  }

  // Basic
  if (authHeader.startsWith("Basic ")) {
    const b64 = authHeader.slice("Basic ".length).trim();
    const decoded = Buffer.from(b64, "base64").toString("utf-8"); // user:pass
    const [u, p] = decoded.split(":");

    if (
      ESEWA_TOKEN_BASIC_USER &&
      ESEWA_TOKEN_BASIC_PASS &&
      u === ESEWA_TOKEN_BASIC_USER &&
      p === ESEWA_TOKEN_BASIC_PASS
    ) {
      return next();
    }

    return res.status(401).json({
      response_code: 1,
      response_message: "Unauthorized: invalid basic auth",
    });
  }

  return res.status(401).json({
    response_code: 1,
    response_message: "Unauthorized: missing auth header",
  });
}

// ========= HELPERS =========
async function findOrderByRequestId(requestId) {
  if (!requestId) return null;

  // 1) by transactionUuid
  let order =
    (await Orders.findOne({ "esewa.transactionUuid": requestId })) || null;
  if (order) return order;

  // 2) by _id (ObjectId)
  if (ObjectId.isValid(requestId)) {
    order = await Orders.findOne({ _id: new ObjectId(requestId) });
    if (order) return order;
  }

  // 3) by orderNumber
  order = await Orders.findOne({ orderNumber: requestId });
  if (order) return order;

  return null;
}

/* ------------------------------------------------------------------
   1) WEBSITE → ESEWA (ePay v2 web checkout)
   POST /api/payment/esewa/initiate
   ✅ NEW FLOW:
   - Frontend first creates order via POST /api/orders (paymentMethod="online")
   - Then calls this endpoint with: { orderId }
   - This route:
     • Verifies order belongs to user
     • Uses order.totals.grandTotal as amount
     • Generates (or reuses) esewa.transactionUuid
     • Returns epay v2 form payload with signature
------------------------------------------------------------------- */
router.post("/esewa/initiate", authMiddleware, async (req, res) => {
  try {
    const user = req.user;
    const { orderId } = req.body || {};

    if (!orderId || !ObjectId.isValid(orderId)) {
      return res.status(400).json({ message: "Valid orderId is required." });
    }

    // Load order
    const order = await Orders.findOne({ _id: new ObjectId(orderId) });
    if (!order) {
      return res.status(404).json({ message: "Order not found." });
    }

    // Ensure order belongs to current user
    const orderUserId = String(order.userId || "");
    if (orderUserId !== String(user.id || user._id || "")) {
      return res.status(403).json({ message: "You are not allowed to pay for this order." });
    }

    // Validate totals
    const amount = Number(order?.totals?.grandTotal || 0);
    if (!amount || amount <= 0) {
      return res.status(400).json({ message: "Invalid order amount for eSewa payment." });
    }

    const now = new Date();

    // Reuse existing transaction UUID if already generated (re-initiate)
    let transactionUuid =
      order?.esewa?.transactionUuid ||
      `GLAMZI-${Date.now()}-${new ObjectId().toString()}`;

    // ePay v2 requires signature
    const productCode = ESEWA_MERCHANT_CODE || "EPAYTEST";
    const secretKey = ESEWA_SECRET_KEY || "8gBm/:&EnhH.1/q";

    // Signature message format: total_amount=X,transaction_uuid=Y,product_code=Z
    const signedFieldNames = "total_amount,transaction_uuid,product_code";
    const signatureMessage = `total_amount=${amount},transaction_uuid=${transactionUuid},product_code=${productCode}`;
    const signature = generateEsewaSignature(signatureMessage, secretKey);

    const esewaPayload = {
      amount: amount.toString(),
      tax_amount: "0",
      total_amount: amount.toString(),
      transaction_uuid: transactionUuid,
      product_code: productCode,
      product_service_charge: "0",
      product_delivery_charge: "0",
      success_url: ESEWA_SUCCESS_URL,
      failure_url: ESEWA_FAILURE_URL,
      signed_field_names: signedFieldNames,
      signature: signature,
    };

    // Persist eSewa meta on order (safe to upsert)
    await Orders.updateOne(
      { _id: order._id },
      {
        $set: {
          "esewa.transactionUuid": transactionUuid,
          "esewa.amount": amount,
          "esewa.environment": ESEWA_ENV || "test",
          "esewa.lastInitiatedAt": now,
          updatedAt: now,
        },
      }
    );

    return res.json({
      success: true,
      message: "eSewa payment initiated",
      orderId: order._id.toString(),
      transactionUuid,
      esewaUrl: ESEWA_ENDPOINT,
      esewaPayload,
    });
  } catch (err) {
    console.error("Error initiating eSewa payment:", err);
    return res
      .status(500)
      .json({ message: "Failed to initiate eSewa payment" });
  }
});

/* ------------------------------------------------------------------
   2) ESEWA SUCCESS CALLBACK
   GET /api/payment/esewa/success
   ↳ eSewa redirects here after successful payment with encoded data
------------------------------------------------------------------- */
router.get("/esewa/success", async (req, res) => {
  try {
    const { data } = req.query;

    if (!data) {
      console.error("eSewa success callback: No data received");
      return res.redirect(ESEWA_FAILURE_URL || "/checkout?error=no_data");
    }

    // Decode base64 data from eSewa
    const decodedData = JSON.parse(
      Buffer.from(data, "base64").toString("utf-8")
    );

    const {
      transaction_uuid,
      transaction_code,
      total_amount,
      status,
      signed_field_names,
      signature,
    } = decodedData;

    console.log("eSewa success callback data:", decodedData);

    // Find order by transaction UUID
    const order = await Orders.findOne({
      "esewa.transactionUuid": transaction_uuid,
    });

    if (!order) {
      console.error(
        "eSewa success callback: Order not found for UUID:",
        transaction_uuid
      );
      return res.redirect(
        ESEWA_FAILURE_URL || "/checkout?error=order_not_found"
      );
    }

    // Verify the signature
    const secretKey = ESEWA_SECRET_KEY || "8gBm/:&EnhH.1/q";
    const fields = signed_field_names.split(",");
    const signatureMessage = fields
      .map((field) => `${field}=${decodedData[field]}`)
      .join(",");
    const expectedSignature = generateEsewaSignature(
      signatureMessage,
      secretKey
    );

    if (signature !== expectedSignature) {
      console.error("eSewa success callback: Signature mismatch");
      // Still update order but flag it for manual verification if needed
    }

    // Verify amount
    const expectedAmount = Number(order.totals?.grandTotal || 0);
    const receivedAmount = Number(total_amount);

    if (expectedAmount !== receivedAmount) {
      console.error("eSewa success callback: Amount mismatch", {
        expected: expectedAmount,
        received: receivedAmount,
      });
    }

    // Update order as paid
    const now = new Date();
    await Orders.updateOne(
      { _id: order._id },
      {
        $set: {
          paymentMethod: "esewa",
          paymentStatus: "paid",

          "payment.method": "esewa",
          "payment.status": "paid",
          "payment.paidAt": now,
          "payment.transactionCode": transaction_code,
          "payment.referenceCode": transaction_uuid,
          status: "paid",
          paidAt: now,
          "esewa.transactionCode": transaction_code,
          "esewa.paidAt": now,
          "esewa.responseData": decodedData,
          updatedAt: now,
        },
      }
    );

    // Mirror payment status to linked invoices (by orderId)
    await Invoices.updateMany(
      { orderId: order._id },
      {
        $set: {
          status: "paid",
          paymentStatus: "paid",
          paidAt: now,
          "payment.method": "esewa",
          "payment.status": "paid",
          "payment.transactionCode": transaction_code,
          "payment.referenceCode": transaction_uuid,
          updatedAt: now,
        },
      }
    );

    // Redirect to success page
    // Redirect back to frontend order success page
    // Uses ESEWA_SUCCESS_URL if provided, otherwise falls back to FRONTEND_URL/order-success
    const frontendBase =
      ESEWA_SUCCESS_URL ||
      `${process.env.FRONTEND_URL || ""}/order-success`;

    const glue = frontendBase.includes("?") ? "&" : "?";
    return res.redirect(`${frontendBase}${glue}orderId=${order._id.toString()}`);
  } catch (err) {
    console.error("Error in eSewa success callback:", err);
    return res.redirect(
      ESEWA_FAILURE_URL || "/checkout?error=processing_error"
    );
  }
});

/* ------------------------------------------------------------------
   3) ESEWA FAILURE CALLBACK
   GET /api/payment/esewa/failure
   ↳ eSewa redirects here after failed/cancelled payment
------------------------------------------------------------------- */
router.get("/esewa/failure", async (req, res) => {
  try {
    const { data } = req.query;

    let transactionUuid = null;

    if (data) {
      try {
        const decodedData = JSON.parse(
          Buffer.from(data, "base64").toString("utf-8")
        );
        transactionUuid = decodedData.transaction_uuid;
        console.log("eSewa failure callback data:", decodedData);
      } catch (e) {
        console.error("Error decoding eSewa failure data:", e);
      }
    }

    // Update order status if we have the transaction UUID
    if (transactionUuid) {
      const now = new Date();
      await Orders.updateOne(
        { "esewa.transactionUuid": transactionUuid },
        {
          $set: {
            "payment.status": "failed",
            status: "cancelled",
            updatedAt: now,
          },
        }
      );
    }

    // Redirect to checkout with error
    const failureUrl = ESEWA_FAILURE_URL || "/checkout";
    return res.redirect(`${failureUrl}?error=payment_failed`);
  } catch (err) {
    console.error("Error in eSewa failure callback:", err);
    return res.redirect(
      ESEWA_FAILURE_URL || "/checkout?error=processing_error"
    );
  }
});

/* ------------------------------------------------------------------
   4) VERIFY ESEWA TRANSACTION (for manual verification)
   POST /api/payment/esewa/verify
   ↳ Verify a transaction with eSewa's status API
------------------------------------------------------------------- */
router.post("/esewa/verify", authMiddleware, async (req, res) => {
  try {
    const { orderId, transactionUuid } = req.body;

    if (!orderId && !transactionUuid) {
      return res
        .status(400)
        .json({ message: "orderId or transactionUuid required" });
    }

    // Find order
    let order;
    if (orderId && ObjectId.isValid(orderId)) {
      order = await Orders.findOne({ _id: new ObjectId(orderId) });
    } else if (transactionUuid) {
      order = await Orders.findOne({
        "esewa.transactionUuid": transactionUuid,
      });
    }

    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    const txnUuid = order.esewa?.transactionUuid;
    if (!txnUuid) {
      return res
        .status(400)
        .json({ message: "No eSewa transaction found for this order" });
    }

    // Call eSewa status API
    const productCode = ESEWA_MERCHANT_CODE || "EPAYTEST";
    const totalAmount = order.totals?.grandTotal || 0;

    const statusUrl = `${ESEWA_STATUS_ENDPOINT}?product_code=${productCode}&total_amount=${totalAmount}&transaction_uuid=${txnUuid}`;

    const response = await fetch(statusUrl, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
      },
    });

    const statusData = await response.json();

    return res.json({
      order: {
        _id: order._id,
        status: order.status,
        paymentStatus: order.payment?.status,
      },
      esewaStatus: statusData,
    });
  } catch (err) {
    console.error("Error verifying eSewa transaction:", err);
    return res.status(500).json({ message: "Failed to verify transaction" });
  }
});

/* ------------------------------------------------------------------
   5) ESEWA → GLAMZI: INQUIRY (for token-based integration)
   GET /api/payment/esewa/inquiry/:request_id
   - Auth: Bearer ESEWA_WEBHOOK_TOKEN
   - Respond with amount + properties for that request_id
------------------------------------------------------------------- */
router.get(
  "/esewa/inquiry/:request_id/:mobile?",
  verifyEsewaCallbackAuth,
  async (req, res) => {
    try {
      const { request_id } = req.params;

      if (!request_id) {
        return res.status(400).json({
          request_id: "",
          response_code: 1,
          response_message: "request_id is required",
        });
      }

      // Find order by esewa.transactionUuid OR by _id
      const order =
        (await Orders.findOne({ "esewa.transactionUuid": request_id })) ||
        (ObjectId.isValid(request_id)
          ? await Orders.findOne({ _id: new ObjectId(request_id) })
          : null);

      if (!order) {
        return res.status(200).json({
          request_id,
          response_code: 1,
          response_message: "Invalid token / request_id not found",
        });
      }

      const amount = Number(order.totals?.grandTotal || 0);

      const properties = {
        customer_name: order.shippingAddress?.fullName || "Glamzi Customer",
        address:
          order.shippingAddress?.addressLine1 ||
          order.shippingAddress?.tole ||
          "Nepal",
        customer_id: String(order.userId),
        invoice_number: order._id.toString(),
        product_name:
          order.items?.length === 1
            ? "Glamzi order - 1 item"
            : `Glamzi order - ${order.items?.length || 0} items`,
      };

      return res.status(200).json({
        request_id,
        response_code: 0,
        response_message: "success",
        amount,
        properties,
      });
    } catch (err) {
      console.error("Error in eSewa inquiry:", err);
      return res.status(500).json({
        request_id: req.params.request_id || "",
        response_code: 1,
        response_message: "Server error during inquiry",
      });
    }
  }
);

/* ------------------------------------------------------------------
   6) ESEWA → GLAMZI: PAYMENT (webhook callback)
   POST /api/payment/esewa/payment
------------------------------------------------------------------- */
router.post("/esewa/payment", verifyEsewaCallbackAuth, async (req, res) => {
  try {
    const { request_id, amount, transaction_code } = req.body || {};

    if (!request_id || !amount || !transaction_code) {
      return res.status(400).json({
        request_id: request_id || "",
        response_code: 1,
        response_message: "Missing required fields",
      });
    }

    const order =
      (await Orders.findOne({ "esewa.transactionUuid": request_id })) ||
      (ObjectId.isValid(request_id)
        ? await Orders.findOne({ _id: new ObjectId(request_id) })
        : null);

    if (!order) {
      return res.status(200).json({
        request_id,
        response_code: 1,
        response_message: "Invalid token / request_id not found",
      });
    }

    const expectedAmount = Number(order.totals?.grandTotal || 0);
    const receivedAmount = Number(amount);

    if (!expectedAmount || expectedAmount !== receivedAmount) {
      return res.status(200).json({
        request_id,
        response_code: 1,
        response_message: "Amount mismatch",
        amount: expectedAmount,
      });
    }

    const now = new Date();

    // Update order as paid
    await Orders.updateOne(
      { _id: order._id },
      {
        $set: {
          "payment.method": "esewa",
          "payment.status": "paid",
          "payment.transactionCode": transaction_code,
          "payment.referenceCode": order._id.toString(),
          status: "paid",
          updatedAt: now,
        },
      }
    );

    return res.status(200).json({
      request_id,
      response_code: 0,
      response_message: "Payment successful",
      amount: expectedAmount,
      reference_code: order._id.toString(),
    });
  } catch (err) {
    console.error("Error in eSewa payment:", err);
    return res.status(500).json({
      request_id: req.body?.request_id || "",
      response_code: 1,
      response_message: "Server error during payment",
    });
  }
});

/* ------------------------------------------------------------------
   7) ESEWA → GLAMZI: STATUS
   POST /api/payment/esewa/status
------------------------------------------------------------------- */
router.post("/esewa/status", verifyEsewaCallbackAuth, async (req, res) => {
  try {
    const { request_id, amount, transaction_code } = req.body || {};

    if (!request_id || !amount || !transaction_code) {
      return res.status(400).json({
        request_id: request_id || "",
        response_code: 1,
        status: "FAILED",
        response_message: "Missing required fields",
      });
    }

    const order =
      (await Orders.findOne({ "esewa.transactionUuid": request_id })) ||
      (ObjectId.isValid(request_id)
        ? await Orders.findOne({ _id: new ObjectId(request_id) })
        : null);

    if (!order) {
      return res.status(200).json({
        request_id,
        response_code: 1,
        status: "FAILED",
        response_message: "Payment Not Found",
        amount: Number(amount),
        reference_code: "",
      });
    }

    const expectedAmount = Number(order.totals?.grandTotal || 0);
    const receivedAmount = Number(amount);

    const statusStr = order.payment?.status === "paid" ? "SUCCESS" : "FAILED";

    return res.status(200).json({
      request_id,
      response_code: statusStr === "SUCCESS" ? 0 : 1,
      status: statusStr,
      response_message:
        statusStr === "SUCCESS"
          ? "Payment successful"
          : "Payment not completed in client system",
      amount: expectedAmount || receivedAmount,
      reference_code: order._id.toString(),
    });
  } catch (err) {
    console.error("Error in eSewa status:", err);
    return res.status(500).json({
      request_id: req.body?.request_id || "",
      response_code: 1,
      status: "FAILED",
      response_message: "Server error during status check",
      amount: Number(req.body?.amount || 0),
      reference_code: "",
    });
  }
});

/* ------------------------------------------------------------------
   8) ESEWA TOKEN INQUIRY (token-based integration)
   Supports GET/POST:
   - Auth: Bearer ESEWA_TOKEN_BEARER or Basic ESEWA_TOKEN_BASIC_USER/PASS
   - request_id may be path param, query, or body
------------------------------------------------------------------- */
router.all(
  ["/esewa/token/inquiry/:requestId?", "/esewa/token/inquiry"],
  verifyEsewaTokenAuth,
  async (req, res) => {
    try {
      const requestId =
        req.params.requestId || req.query.request_id || req.body?.request_id || "";

      if (!requestId) {
        return res.status(400).json({
          request_id: "",
          response_code: 1,
          response_message: "request_id is required",
        });
      }

      const order = await findOrderByRequestId(requestId);

      if (!order) {
        return res.status(200).json({
          request_id: requestId,
          response_code: 1,
          response_message: "Invalid token / request_id not found",
        });
      }

      const amount = Number(order.totals?.grandTotal || 0);

      const properties = {
        customer_name: order.shippingAddress?.fullName || "Glamzi Customer",
        address:
          order.shippingAddress?.addressLine1 ||
          order.shippingAddress?.tole ||
          "Nepal",
        customer_id: String(order.userId || ""),
        order_id: order._id.toString(),
        seller_id: order.sellerId ? String(order.sellerId) : "",
      };

      return res.status(200).json({
        request_id: requestId,
        response_code: 0,
        response_message: "success",
        amount,
        properties,
      });
    } catch (err) {
      console.error("Error in eSewa token inquiry:", err);
      return res.status(500).json({
        request_id: req.params.requestId || "",
        response_code: 1,
        response_message: "Server error during inquiry",
      });
    }
  }
);

/* ------------------------------------------------------------------
   9) ESEWA TOKEN PAYMENT
   POST /api/payment/esewa/token/payment
------------------------------------------------------------------- */
router.post(
  "/esewa/token/payment",
  verifyEsewaTokenAuth,
  async (req, res) => {
    try {
      const { request_id, amount, transaction_code, reference_code } =
        req.body || {};

      if (!request_id || !amount || !transaction_code) {
        return res.status(400).json({
          request_id: request_id || "",
          response_code: 1,
          response_message: "Missing required fields",
        });
      }

      const order = await findOrderByRequestId(request_id);

      if (!order) {
        return res.status(200).json({
          request_id,
          response_code: 1,
          response_message: "Invalid token / request_id not found",
        });
      }

      const expectedAmount = Number(order.totals?.grandTotal || 0);
      const receivedAmount = Number(amount);

      if (!expectedAmount || expectedAmount !== receivedAmount) {
        return res.status(200).json({
          request_id,
          response_code: 1,
          response_message: "Amount mismatch",
          amount: expectedAmount,
        });
      }

      const now = new Date();

      // Update order as paid
      await Orders.updateOne(
        { _id: order._id },
        {
          $set: {
            paymentMethod: "esewa",
            paymentStatus: "paid",

            "payment.method": "esewa",
            "payment.status": "paid",
            "payment.paidAt": now,
            "payment.transactionCode": transaction_code,
            "payment.referenceCode": reference_code || transaction_code,

            status: "paid",
            paidAt: now,
            "esewa.transactionCode": transaction_code,
            "esewa.paidAt": now,
            updatedAt: now,
          },
        }
      );

      // Mirror payment status to linked invoices (by orderId)
      await Invoices.updateMany(
        { orderId: order._id },
        {
          $set: {
            status: "paid",
            paymentStatus: "paid",
            paidAt: now,
            "payment.method": "esewa",
            "payment.status": "paid",
            "payment.transactionCode": transaction_code,
            "payment.referenceCode": reference_code || transaction_code,
            updatedAt: now,
          },
        }
      );

      return res.status(200).json({
        request_id,
        response_code: 0,
        response_message: "Payment successful",
        amount: expectedAmount,
        reference_code: reference_code || transaction_code,
      });
    } catch (err) {
      console.error("Error in eSewa token payment:", err);
      return res.status(500).json({
        request_id: req.body?.request_id || "",
        response_code: 1,
        response_message: "Server error during payment",
      });
    }
  }
);

/* ------------------------------------------------------------------
   10) ESEWA TOKEN STATUS
   POST /api/payment/esewa/token/status
------------------------------------------------------------------- */
router.post(
  "/esewa/token/status",
  verifyEsewaTokenAuth,
  async (req, res) => {
    try {
      const { request_id, amount, transaction_code } = req.body || {};

      if (!request_id || !amount || !transaction_code) {
        return res.status(400).json({
          request_id: request_id || "",
          response_code: 1,
          status: "FAILED",
          response_message: "Missing required fields",
        });
      }

      const order = await findOrderByRequestId(request_id);

      if (!order) {
        return res.status(200).json({
          request_id,
          response_code: 3,
          status: "NOT FOUND",
          response_message: "Payment not found",
          amount: Number(amount),
          reference_code: "",
        });
      }

      const expectedAmount = Number(order.totals?.grandTotal || 0) || Number(amount);
      const paid =
        order.paymentStatus === "paid" ||
        order.payment?.status === "paid" ||
        order.status === "paid";

      let statusStr = "PENDING";
      let responseCode = 2;

      if (paid) {
        statusStr = "SUCCESS";
        responseCode = 0;
      } else if (order.payment?.status === "failed") {
        statusStr = "FAILED";
        responseCode = 1;
      }

      return res.status(200).json({
        request_id,
        response_code: responseCode,
        status: statusStr,
        response_message:
          statusStr === "SUCCESS"
            ? "Payment successful"
            : statusStr === "FAILED"
            ? "Payment failed"
            : "Payment is being processed",
        amount: expectedAmount,
        reference_code:
          order.payment?.referenceCode ||
          order.payment?.transactionCode ||
          transaction_code ||
          "",
      });
    } catch (err) {
      console.error("Error in eSewa token status:", err);
      return res.status(500).json({
        request_id: req.body?.request_id || "",
        response_code: 1,
        status: "FAILED",
        response_message: "Server error during status check",
        amount: Number(req.body?.amount || 0),
        reference_code: "",
      });
    }
  }
);

export default router;
