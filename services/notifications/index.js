import { client } from "../../dbConfig.js";
import { renderEmail } from "./renderEmail.js";
import { sendEmail } from "./providers/sendgridProvider.js";

const db = client.db(process.env.DB_NAME || "glamzi_ecommerce");
const Users = db.collection("users");
const NotificationDeliveries = db.collection("notificationDeliveries");
const NotificationSettings = db.collection("notificationSettings");

const APP_PUBLIC_URL = process.env.APP_PUBLIC_URL || "https://glamzibeauty.com";
const BRAND_LOGO_URL =
  process.env.BRAND_LOGO_URL || `${APP_PUBLIC_URL}/assets/logo-2cb1acee.webp`;
const BRAND_PRIMARY_COLOR = process.env.BRAND_PRIMARY_COLOR || "#F22A83";
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || "support@glamzibeauty.com";
const SELLER_SUPPORT_EMAIL =
  process.env.SELLER_SUPPORT_EMAIL || "seller-support@glamzibeauty.com";
const SETTLEMENTS_EMAIL =
  process.env.SETTLEMENTS_EMAIL || "settlements@glamzibeauty.com";

function baseTemplateVars(extra = {}) {
  return {
    brandLogoUrl: BRAND_LOGO_URL,
    brandName: "Glamzi Beauty",
    brandPrimaryColor: BRAND_PRIMARY_COLOR,
    supportEmail: SUPPORT_EMAIL,
    year: new Date().getFullYear(),
    ...extra,
  };
}

function redactEmail(email) {
  if (!email) return "";
  const [name, domain] = String(email).split("@");
  if (!domain) return "redacted";
  return `${name?.[0] || "*"}***@${domain}`;
}

async function getSettings() {
  const settings =
    (await NotificationSettings.findOne({ _id: "default" })) || null;
  return (
    settings || {
      emailEnabledByType: {},
      sellerEmailsEnabled: true,
      customerEmailsEnabled: true,
    }
  );
}

async function resolveCustomerEmail(customerId) {
  if (!customerId) return null;
  const user = await Users.findOne(
    { _id: customerId },
    { projection: { email: 1, name: 1 } }
  );
  return { email: user?.email || null, name: user?.name || "Customer" };
}

async function resolveSellerEmail(sellerId) {
  if (!sellerId) return null;
  const user = await Users.findOne(
    { _id: sellerId },
    { projection: { email: 1, storeName: 1, name: 1 } }
  );
  return {
    email: user?.email || null,
    name: user?.storeName || user?.name || "Seller",
  };
}

export async function deliverEmail({
  eventId,
  dedupeKey,
  to,
  subject,
  templateId,
  templateData,
  attachments = [],
  meta = {},
}) {
  const now = new Date();
  const deliveryDoc = {
    channel: "email",
    provider: "sendgrid",
    to,
    templateId,
    dedupeKey,
    eventId,
    status: "queued",
    attempts: 0,
    meta,
    createdAt: now,
    updatedAt: now,
  };

  try {
    await NotificationDeliveries.insertOne(deliveryDoc);
  } catch (err) {
    if (err?.code === 11000) {
      return { ok: true, deduped: true };
    }
    throw err;
  }

  const { html } = renderEmail(templateId, templateData);
  const text = templateData?.plainText || "";

  const result = await sendEmail({
    to,
    subject,
    html,
    text,
    customArgs: { eventId: String(eventId || "") },
    attachments,
  });

  await NotificationDeliveries.updateOne(
    { dedupeKey },
    {
      $set: {
        status: "sent",
        providerMessageId: result?.messageId || null,
        updatedAt: new Date(),
      },
    }
  );

  return { ok: true };
}

export async function handleEvent(event) {
  const settings = await getSettings();
  const type = String(event.type || "");

  if (settings.emailEnabledByType?.[type] === false) {
    return { skipped: true, reason: "disabled_by_settings" };
  }

  // ===== Order placed =====
  if (type === "order.placed") {
    if (!settings.customerEmailsEnabled) return { skipped: true };
    const customerId = event.refs?.customerId;
    const customer = await resolveCustomerEmail(customerId);
    if (!customer?.email) return { skipped: true, reason: "missing_customer_email" };

    const orderNumber = event.payload?.orderNumber || "";
    const subject = `Order placed - ${orderNumber || "Glamzi"}`;
    const templateData = baseTemplateVars({
      customerName: customer.name,
      orderNumber,
      orderLink: `${APP_PUBLIC_URL}/orders`,
    });
    const dedupeKey = `email:order.placed:${customer.email}:${event.dedupeKey}`;
    return deliverEmail({
      eventId: event._id,
      dedupeKey,
      to: customer.email,
      subject,
      templateId: "order_placed_customer",
      templateData,
    });
  }

  // ===== Order status update =====
  if (type === "order.status_changed") {
    if (!settings.customerEmailsEnabled) return { skipped: true };
    const customerId = event.refs?.customerId;
    const customer = await resolveCustomerEmail(customerId);
    if (!customer?.email) return { skipped: true, reason: "missing_customer_email" };

    const status = String(event.payload?.status || "updated").toLowerCase();
    const orderNumber = event.payload?.orderNumber || "";
    let templateId = "order_shipped_customer";
    if (status === "delivered" || status === "completed") {
      templateId = "order_delivered_customer";
    }
    if (status === "cancelled" || status === "canceled") {
      templateId = "order_cancelled_customer";
    }
    const subject = `Order update - ${orderNumber || ""}`;
    const templateData = baseTemplateVars({
      customerName: customer.name,
      orderNumber,
      trackingNumber: event.payload?.trackingNumber || "",
      courier: event.payload?.courier || "",
      eta: event.payload?.eta || "",
      trackingLink: `${APP_PUBLIC_URL}/orders`,
      cancelReason: event.payload?.cancelReason || "",
      refundStatus: event.payload?.refundStatus || "",
      supportLink: `${APP_PUBLIC_URL}/contact`,
      orderLink: `${APP_PUBLIC_URL}/orders`,
    });
    const dedupeKey = `email:order.status_changed:${customer.email}:${event.dedupeKey}`;
    return deliverEmail({
      eventId: event._id,
      dedupeKey,
      to: customer.email,
      subject,
      templateId,
      templateData,
    });
  }

  // ===== Return created =====
  if (type === "return.created") {
    if (!settings.customerEmailsEnabled) return { skipped: true };
    const customerId = event.refs?.customerId;
    const customer = await resolveCustomerEmail(customerId);
    if (!customer?.email) return { skipped: true, reason: "missing_customer_email" };

    const orderNumber = event.payload?.orderNumber || "";
    const subject = `Return request received - ${orderNumber || ""}`;
    const templateData = baseTemplateVars({
      customerName: customer.name,
      returnReference: event.payload?.returnReference || "",
      orderNumber,
      expectedResponseWindow: event.payload?.expectedResponseWindow || "",
      items: event.payload?.items || [],
      returnLink: `${APP_PUBLIC_URL}/returns`,
    });
    const dedupeKey = `email:return.created:${customer.email}:${event.dedupeKey}`;
    return deliverEmail({
      eventId: event._id,
      dedupeKey,
      to: customer.email,
      subject,
      templateId: "return_created_customer",
      templateData,
    });
  }

  // ===== Return decision =====
  if (type === "return.decision_made") {
    if (!settings.customerEmailsEnabled) return { skipped: true };
    const customerId = event.refs?.customerId;
    const customer = await resolveCustomerEmail(customerId);
    if (!customer?.email) return { skipped: true, reason: "missing_customer_email" };

    const decision = String(event.payload?.decision || "updated");
    const orderNumber = event.payload?.orderNumber || "";
    const subject = `Return ${decision} - ${orderNumber || ""}`;
    const templateData = baseTemplateVars({
      customerName: customer.name,
      orderNumber,
      decision,
      returnReference: event.payload?.returnReference || "",
      decisionReason: event.payload?.decisionReason || "",
      refundAmount: event.payload?.refundAmount || "",
      returnLink: `${APP_PUBLIC_URL}/returns`,
    });
    const dedupeKey = `email:return.decision:${customer.email}:${event.dedupeKey}`;
    return deliverEmail({
      eventId: event._id,
      dedupeKey,
      to: customer.email,
      subject,
      templateId: "return_decision_customer",
      templateData,
    });
  }

  // ===== New order for seller =====
  if (type === "order.placed.seller") {
    if (!settings.sellerEmailsEnabled) return { skipped: true };
    const sellerId = event.refs?.sellerId;
    const seller = await resolveSellerEmail(sellerId);
    if (!seller?.email) return { skipped: true, reason: "missing_seller_email" };

    const orderNumber = event.payload?.orderNumber || "";
    const subject = `New order received - ${orderNumber || ""}`;
    const templateData = baseTemplateVars({
      sellerStoreName: seller.name,
      orderNumber,
      items: event.payload?.items || [],
      segmentSubtotal: event.payload?.segmentSubtotal || "",
      segmentShipping: event.payload?.segmentShipping || "",
      segmentTotal: event.payload?.segmentTotal || "",
      shipBy: event.payload?.shipBy || "",
      sellerOrderLink: `${APP_PUBLIC_URL}/seller/dashboard/orders/orderslisting`,
      sellerSupportEmail: SELLER_SUPPORT_EMAIL,
    });
    const dedupeKey = `email:order.placed.seller:${seller.email}:${event.dedupeKey}`;
    return deliverEmail({
      eventId: event._id,
      dedupeKey,
      to: seller.email,
      subject,
      templateId: "new_order_seller",
      templateData,
    });
  }

  // ===== Return request seller =====
  if (type === "return.created.seller") {
    if (!settings.sellerEmailsEnabled) return { skipped: true };
    const sellerId = event.refs?.sellerId;
    const seller = await resolveSellerEmail(sellerId);
    if (!seller?.email) return { skipped: true, reason: "missing_seller_email" };

    const orderNumber = event.payload?.orderNumber || "";
    const subject = `Return request - ${orderNumber || ""}`;
    const templateData = baseTemplateVars({
      sellerStoreName: seller.name,
      returnReference: event.payload?.returnReference || "",
      orderNumber,
      items: event.payload?.items || [],
      sellerActionDeadline: event.payload?.sellerActionDeadline || "",
      sellerReturnLink: `${APP_PUBLIC_URL}/seller/dashboard/orders/returns`,
      sellerSupportEmail: SELLER_SUPPORT_EMAIL,
    });
    const dedupeKey = `email:return.created.seller:${seller.email}:${event.dedupeKey}`;
    return deliverEmail({
      eventId: event._id,
      dedupeKey,
      to: seller.email,
      subject,
      templateId: "return_request_seller",
      templateData,
    });
  }

  // ===== Seller order status update =====
  if (type === "order.seller_status_changed") {
    if (!settings.sellerEmailsEnabled) return { skipped: true };
    const sellerId = event.refs?.sellerId;
    const seller = await resolveSellerEmail(sellerId);
    if (!seller?.email) return { skipped: true, reason: "missing_seller_email" };

    const status = event.payload?.status || "updated";
    const orderNumber = event.payload?.orderNumber || "";
    const subject = `Order update - ${orderNumber || ""}`;
    const templateData = baseTemplateVars({
      sellerStoreName: seller.name,
      orderNumber,
      status,
      sellerOrderLink: `${APP_PUBLIC_URL}/seller/dashboard/orders/orderslisting`,
      sellerSupportEmail: SELLER_SUPPORT_EMAIL,
    });
    const dedupeKey = `email:order.seller_status_changed:${seller.email}:${event.dedupeKey}`;
    return deliverEmail({
      eventId: event._id,
      dedupeKey,
      to: seller.email,
      subject,
      templateId: "seller_order_status_update",
      templateData,
    });
  }

  // ===== Settlement report =====
  if (type === "settlement.seller_report_ready") {
    if (!settings.sellerEmailsEnabled) return { skipped: true };
    const sellerId = event.refs?.sellerId;
    const seller = await resolveSellerEmail(sellerId);
    if (!seller?.email) return { skipped: true, reason: "missing_seller_email" };

    const subject = `Settlement report - ${event.payload?.dateKey || ""}`;
    const reportUrl = event.payload?.reportUrl || "";
    const attachments = event.payload?.attachment
      ? [
          {
            content: event.payload.attachment,
            filename: `settlement-${event.payload?.dateKey || "report"}.pdf`,
            type: "application/pdf",
            disposition: "attachment",
          },
        ]
      : [];

    const templateData = baseTemplateVars({
      sellerStoreName: seller.name,
      dateKey: event.payload?.dateKey || "",
      grossSales: event.payload?.grossSales || "",
      returnsTotal: event.payload?.returnsTotal || "",
      commissionTotal: event.payload?.commissionTotal || "",
      shippingTotal: event.payload?.shippingTotal || "",
      netSettlement: event.payload?.netSettlement || "",
      note: event.payload?.note || "",
      sellerSettlementLink: reportUrl || `${APP_PUBLIC_URL}/seller/dashboard/finance/settlements`,
      settlementsEmail: SETTLEMENTS_EMAIL,
    });
    const dedupeKey = `email:settlement.report:${seller.email}:${event.dedupeKey}`;
    return deliverEmail({
      eventId: event._id,
      dedupeKey,
      to: seller.email,
      subject,
      templateId: "settlement_report_seller",
      templateData,
      attachments,
    });
  }


  return { skipped: true, reason: "unhandled_event" };
}

export { getSettings };
