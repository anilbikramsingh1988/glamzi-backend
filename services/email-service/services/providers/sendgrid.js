import sgMail from "@sendgrid/mail";

const apiKey = process.env.SENDGRID_API_KEY;
const defaultFrom = process.env.EMAIL_DEFAULT_FROM || "Glamzi Beauty <info@glamzibeauty.com>";
const ipPool = process.env.SENDGRID_IP_POOL || null;
const categoryPrefix = process.env.SENDGRID_CATEGORY_PREFIX || "glamzi";

if (!apiKey) {
  throw new Error("SENDGRID_API_KEY is required");
}

sgMail.setApiKey(apiKey);

function normalizeAddress(addr) {
  if (!addr) return null;
  if (typeof addr === "string") return addr;
  if (addr.email) {
    return addr.name ? `${addr.name} <${addr.email}>` : addr.email;
  }
  return null;
}

export async function sendEmail({
  from,
  replyTo,
  to,
  cc,
  bcc,
  subject,
  html,
  text,
  attachments,
  customArgs,
  category,
}) {
  const msg = {
    from: normalizeAddress(from) || defaultFrom,
    replyTo: normalizeAddress(replyTo) || undefined,
    to,
    cc,
    bcc,
    subject,
    html,
    text,
    attachments,
    customArgs,
    categories: [categoryPrefix, category].filter(Boolean),
  };

  if (ipPool) {
    msg.ipPoolName = ipPool;
  }

  const [res] = await sgMail.send(msg);
  const messageId = res?.headers?.["x-message-id"] || res?.headers?.["x-messageid"] || null;
  return { messageId };
}
