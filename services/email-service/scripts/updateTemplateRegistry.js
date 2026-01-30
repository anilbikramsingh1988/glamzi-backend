import { connectDb } from "../db.js";

const now = new Date();

const templates = [
  {
    key: "order_delivered_customer",
    category: "transactional",
    fromKey: "orders",
    allowedVariables: [
      "brandPrimaryColor",
      "brandLogoUrl",
      "brandName",
      "orderNumber",
      "orderLink",
      "supportEmail",
      "year",
    ],
    isBlockEditable: false,
  },
  {
    key: "order_cancelled_customer",
    category: "transactional",
    fromKey: "orders",
    allowedVariables: [
      "brandPrimaryColor",
      "brandLogoUrl",
      "brandName",
      "orderNumber",
      "cancelReason",
      "refundStatus",
      "supportLink",
      "supportEmail",
      "year",
    ],
    isBlockEditable: false,
  },
  {
    key: "return_decision_customer",
    category: "transactional",
    fromKey: "returns",
    allowedVariables: [
      "brandPrimaryColor",
      "brandLogoUrl",
      "brandName",
      "returnReference",
      "decision",
      "decisionReason",
      "refundAmount",
      "returnLink",
      "supportEmail",
      "year",
    ],
    isBlockEditable: false,
  },
  {
    key: "return_pickup_scheduled_customer",
    category: "transactional",
    fromKey: "returns",
    allowedVariables: [
      "brandPrimaryColor",
      "brandLogoUrl",
      "brandName",
      "returnReference",
      "pickupDate",
      "pickupWindow",
      "pickupCarrier",
      "returnLink",
      "supportEmail",
      "year",
    ],
    isBlockEditable: false,
  },
  {
    key: "password_reset_customer",
    category: "operational",
    fromKey: "support",
    allowedVariables: [
      "brandPrimaryColor",
      "brandLogoUrl",
      "brandName",
      "resetExpiry",
      "resetLink",
      "supportEmail",
      "year",
    ],
    isBlockEditable: false,
  },
  {
    key: "otp_customer",
    category: "operational",
    fromKey: "support",
    allowedVariables: [
      "brandPrimaryColor",
      "brandLogoUrl",
      "brandName",
      "otpCode",
      "otpExpiry",
      "supportEmail",
      "year",
    ],
    isBlockEditable: false,
  },
  {
    key: "seller_payout_processed",
    category: "operational",
    fromKey: "settlements",
    allowedVariables: [
      "brandPrimaryColor",
      "brandLogoUrl",
      "brandName",
      "sellerStoreName",
      "payoutBatch",
      "payoutAmount",
      "payoutMethod",
      "payoutReference",
      "payoutLink",
      "settlementsEmail",
      "year",
    ],
    isBlockEditable: false,
  },
  {
    key: "system_alert_admin",
    category: "operational",
    fromKey: "alerts",
    allowedVariables: [
      "brandPrimaryColor",
      "brandLogoUrl",
      "brandName",
      "alertTitle",
      "alertMessage",
      "alertContext",
      "alertLink",
      "alertId",
      "year",
    ],
    isBlockEditable: false,
  },
];

const db = await connectDb();

for (const template of templates) {
  await db.collection("emailTemplates").updateOne(
    { key: template.key },
    {
      $set: {
        category: template.category,
        fromKey: template.fromKey,
        allowedVariables: template.allowedVariables,
        isBlockEditable: template.isBlockEditable,
        updatedAt: now,
      },
      $setOnInsert: {
        key: template.key,
        createdAt: now,
      },
    },
    { upsert: true }
  );
}

console.log(`Upserted ${templates.length} templates into emailTemplates.`);
process.exit(0);
