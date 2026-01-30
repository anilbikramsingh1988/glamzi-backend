import { client } from "../../dbConfig.js";
import { renderEmail } from "./renderEmail.js";
import { sendEmail } from "./providers/sendgridProvider.js";

const db = client.db(process.env.DB_NAME || "glamzi_ecommerce");
const Users = db.collection("users");
const NotificationDeliveries = db.collection("notificationDeliveries");
const NotificationSettings = db.collection("notificationSettings");

const APP_PUBLIC_URL = process.env.APP_PUBLIC_URL || "https://glamzibeauty.com";
const BRAND_LOGO_URL = process.env.BRAND_LOGO_URL || `${APP_PUBLIC_URL}/favicon.png`;

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

    const subject = `Order placed - ${event.payload?.orderNumber || "Glamzi"}`;
    const templateData = {
      brandLogoUrl: BRAND_LOGO_URL,
      customerName: customer.name,
      orderNumber: event.payload?.orderNumber || "",
      orderLink: `${APP_PUBLIC_URL}/orders`,
      plainText: `Your order ${event.payload?.orderNumber || ""} was placed successfully.`,
    };
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

    const status = event.payload?.status || "updated";
    const subject = `Order update - ${event.payload?.orderNumber || ""}`;
    const templateData = {
      brandLogoUrl: BRAND_LOGO_URL,
      customerName: customer.name,
      orderNumber: event.payload?.orderNumber || "",
      status,
      orderLink: `${APP_PUBLIC_URL}/orders`,
      plainText: `Your order status is now ${status}.`,
    };
    const dedupeKey = `email:order.status_changed:${customer.email}:${event.dedupeKey}`;
    return deliverEmail({
      eventId: event._id,
      dedupeKey,
      to: customer.email,
      subject,
      templateId: "order_status_update_customer",
      templateData,
    });
  }

  // ===== Return created =====
  if (type === "return.created") {
    if (!settings.customerEmailsEnabled) return { skipped: true };
    const customerId = event.refs?.customerId;
    const customer = await resolveCustomerEmail(customerId);
    if (!customer?.email) return { skipped: true, reason: "missing_customer_email" };

    const subject = `Return request received - ${event.payload?.orderNumber || ""}`;
    const templateData = {
      brandLogoUrl: BRAND_LOGO_URL,
      customerName: customer.name,
      orderNumber: event.payload?.orderNumber || "",
      returnLink: `${APP_PUBLIC_URL}/returns`,
      plainText: `Your return request for order ${event.payload?.orderNumber || ""} is under review.`,
    };
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

    const decision = event.payload?.decision || "updated";
    const subject = `Return ${decision} — ${event.payload?.orderNumber || ""}`;
    const templateData = {
      brandLogoUrl: BRAND_LOGO_URL,
      customerName: customer.name,
      orderNumber: event.payload?.orderNumber || "",
      decision,
      returnLink: `${APP_PUBLIC_URL}/returns`,
      plainText: `Your return request for order ${event.payload?.orderNumber || ""} was ${decision}.`,
    };
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

    const subject = `New order received — ${event.payload?.orderNumber || ""}`;
    const templateData = {
      brandLogoUrl: BRAND_LOGO_URL,
      sellerName: seller.name,
      orderNumber: event.payload?.orderNumber || "",
      sellerLink: `${APP_PUBLIC_URL}/seller/dashboard/orders/orderslisting`,
      plainText: `You have a new order ${event.payload?.orderNumber || ""}.`,
    };
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

    const subject = `Return request - ${event.payload?.orderNumber || ""}`;
    const templateData = {
      brandLogoUrl: BRAND_LOGO_URL,
      sellerName: seller.name,
      orderNumber: event.payload?.orderNumber || "",
      sellerLink: `${APP_PUBLIC_URL}/seller/dashboard/orders/returns`,
      plainText: `Return requested for order ${event.payload?.orderNumber || ""}.`,
    };
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
    const subject = `Order update - ${event.payload?.orderNumber || ""}`;
    const templateData = {
      brandLogoUrl: BRAND_LOGO_URL,
      sellerName: seller.name,
      orderNumber: event.payload?.orderNumber || "",
      status,
      sellerLink: `${APP_PUBLIC_URL}/seller/dashboard/orders/orderslisting`,
      plainText: `Order ${event.payload?.orderNumber || ""} is now ${status}.`,
    };
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

    const templateData = {
      brandLogoUrl: BRAND_LOGO_URL,
      sellerName: seller.name,
      dateKey: event.payload?.dateKey || "",
      reportUrl,
      summary: event.payload?.summary || {},
      plainText: reportUrl
        ? `Your settlement report is ready: ${reportUrl}`
        : `Your settlement report is attached.`,
    };
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
