import nodemailer from "nodemailer";
import dotenv from "dotenv";
dotenv.config();

export const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.MAIL_USER,
    pass: process.env.MAIL_PASS
  }
});

export const sendMail = async ({ to, subject, html }) => {
  await transporter.sendMail({
    from: `"MyEcommerce" <${process.env.MAIL_USER}>`,
    to,
    subject,
    html
  });
};
