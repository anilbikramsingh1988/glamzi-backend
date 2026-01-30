import express from "express";
import dotenv from "dotenv";

import { connectDb } from "./db.js";
import emailRoutes from "./routes/emailRoutes.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 8088;

app.use(express.json({ limit: "5mb" }));

app.get("/health", async (req, res) => {
  try {
    await connectDb();
    res.json({ ok: true, status: "healthy" });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: "DB", message: "DB connection failed" } });
  }
});

app.get("/ready", async (req, res) => {
  try {
    await connectDb();
    res.json({ ok: true, status: "ready" });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: "DB", message: "DB connection failed" } });
  }
});

app.use("/api/email", emailRoutes);

app.listen(PORT, () => {
  console.log(`Email service listening on ${PORT}`);
});
