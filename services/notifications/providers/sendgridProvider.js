import sgMail from "@sendgrid/mail";

const apiKey = process.env.SENDGRID_API_KEY || "";
const fromEmail =
  process.env.EMAIL_FROM || "Glamzi Beauty <info@glamzibeauty.com>";
const replyTo = process.env.EMAIL_REPLY_TO || undefined;

let configured = false;

function ensureConfigured() {
  if (configured) return true;
  if (!apiKey) return false;
  sgMail.setApiKey(apiKey);
  configured = true;
  return true;
}

export async function sendEmail({
  to,
  subject,
  html,
  text,
  headers = {},
  customArgs = {},
  attachments = [],
}) {
  if (!ensureConfigured()) {
    throw new Error("SendGrid not configured");
  }
  if (!to) throw new Error("Missing recipient");

  const msg = {
    to,
    from: fromEmail,
    subject,
    html,
    text,
    headers,
    customArgs,
  };

  if (replyTo) msg.replyTo = replyTo;
  if (attachments?.length) msg.attachments = attachments;

  const [res] = await sgMail.send(msg);
  const messageId =
    res?.headers?.["x-message-id"] ||
    res?.headers?.["X-Message-Id"] ||
    null;
  return { messageId };
}
