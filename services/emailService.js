// services/emailService.js
import nodemailer from "nodemailer";
import dotenv from "dotenv";

dotenv.config();

// You can replace this with your real SMTP credentials
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || "smtp.gmail.com",
  port: Number(process.env.SMTP_PORT) || 587,
  secure: false,
  auth: {
    user: process.env.SMTP_USER || "youremail@example.com",
    pass: process.env.SMTP_PASS || "yourpassword",
  },
});

export async function sendInviteEmail({ to, name, tempPassword }) {
  const appName = "Glamzi Admin Panel";

  const mailOptions = {
    from: process.env.SMTP_FROM || `"${appName}" <no-reply@glamzi.com>`,
    to,
    subject: `Your ${appName} access details`,
    html: `
      <p>Hi ${name || "there"},</p>
      <p>An account has been created for you on the <b>${appName}</b>.</p>
      <p><b>Temporary password:</b> ${tempPassword}</p>
      <p>Please log in and change your password as soon as possible.</p>
      <p>Login URL: <a href="${
        process.env.ADMIN_LOGIN_URL || "https://admin.glamzi.com.np/login"
      }">Admin Login</a></p>
      <p>Regards,<br/>Glamzi Team</p>
    `,
  };

  await transporter.sendMail(mailOptions);
}

export async function sendPasswordResetEmail({ to, name, tempPassword }) {
  const appName = "Glamzi Admin Panel";

  const mailOptions = {
    from: process.env.SMTP_FROM || `"${appName}" <no-reply@glamzi.com>`,
    to,
    subject: `Your ${appName} password has been reset`,
    html: `
      <p>Hi ${name || "there"},</p>
      <p>Your password has been reset by an administrator.</p>
      <p><b>New temporary password:</b> ${tempPassword}</p>
      <p>Please log in and change your password immediately.</p>
      <p>Login URL: <a href="${
        process.env.ADMIN_LOGIN_URL || "https://admin.glamzi.com.np/login"
      }">Admin Login</a></p>
      <p>Regards,<br/>Glamzi Team</p>
    `,
  };

  await transporter.sendMail(mailOptions);
}
