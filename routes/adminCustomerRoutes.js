import express from "express";
import dotenv from "dotenv";
import { ObjectId } from "mongodb";

import { client } from "../dbConfig.js";
import { authMiddleware } from "../middlewares/authMiddleware.js";

dotenv.config();

const router = express.Router();

// Helper: get DB + collection
const getUsersCollection = () => {
  const dbName = process.env.DB_NAME || "glamzi"; // 🔁 change if your DB name is different
  const db = client.db(dbName);
  return db.collection("users");
};

/**
 * GET /api/admin/customers
 * List customers for Admin UI (Customers page)
 *
 * Optional query params:
 *   - search: text search on name/email/phone
 *   - limit, page: for basic pagination
 */
router.get("/customers", authMiddleware, async (req, res) => {
  try {
    const usersCol = getUsersCollection();

    const {
      search = "",
      page = 1,
      limit = 20,
    } = req.query;

    const pageNum = Number(page) || 1;
    const limitNum = Number(limit) || 20;

    const filter = {
      // assuming you store role field, adjust if different in your DB
      role: "customer",
    };

    if (search && search.trim()) {
      const regex = new RegExp(search.trim(), "i");
      filter.$or = [
        { name: regex },
        { email: regex },
        { phone: regex },
      ];
    }

    const skip = (pageNum - 1) * limitNum;

    const [items, total] = await Promise.all([
      usersCol
        .find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .toArray(),
      usersCol.countDocuments(filter),
    ]);

    res.json({
      items,
      total,
      page: pageNum,
      limit: limitNum,
      totalPages: Math.ceil(total / limitNum),
    });
  } catch (err) {
    console.error("❌ Error fetching admin customers:", err);
    res.status(500).json({ message: "Failed to fetch customers" });
  }
});

/**
 * GET /api/admin/customers/:id
 * Single customer details view for Admin
 */
router.get("/customers/:id", authMiddleware, async (req, res) => {
  try {
    const usersCol = getUsersCollection();
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid customer ID" });
    }

    const customer = await usersCol.findOne({ _id: new ObjectId(id) });

    if (!customer) {
      return res.status(404).json({ message: "Customer not found" });
    }

    res.json(customer);
  } catch (err) {
    console.error("❌ Error fetching customer details:", err);
    res.status(500).json({ message: "Failed to fetch customer details" });
  }
});

export default router;
