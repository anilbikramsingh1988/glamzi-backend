import dotenv from "dotenv";
import sgMail from "@sendgrid/mail";

dotenv.config();

const apiKey = process.env.SENDGRID_API_KEY;
const from = process.env.EMAIL_FROM || "Glamzi Beauty <info@glamzibeauty.com>";
const to = process.env.SENDGRID_TEST_TO || process.env.EMAIL_REPLY_TO || process.env.SMTP_USER;

if (!apiKey) {
  console.error("SENDGRID_API_KEY is missing. Set it in .env or environment.");
  process.exit(1);
}
if (!to) {
  console.error("SENDGRID_TEST_TO is missing. Set it to your email address.");
  process.exit(1);
}

sgMail.setApiKey(apiKey);

const msg = {
  to,
  from,
  subject: "Glamzi SendGrid test",
  text: "Hello from Glamzi backend via SendGrid.",
  html: "<p>Hello from <strong>Glamzi</strong> backend via SendGrid.</p>",
};

sgMail
  .send(msg)
  .then(() => {
    console.log("SendGrid test email sent to", to);
    process.exit(0);
  })
  .catch((err) => {
    console.error("SendGrid test failed:", err?.response?.body || err?.message || err);
    process.exit(1);
  });
