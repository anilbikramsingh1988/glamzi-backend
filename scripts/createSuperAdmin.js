import bcrypt from "bcryptjs";
import dotenv from "dotenv";
import { client } from "../dbConfig.js";

dotenv.config();

async function createSuperAdmin() {
  const db = client.db("glamzi_ecommerce"); // Uses DB from MONGO_URI
  const Users = db.collection("users");

  // CHANGE THESE VALUES (SAFE FOR FIRST ADMIN)
  const firstName = "Anil";
  const lastName = "Singh";
  const email = "sahasiyatri@gmail.com";      // ⚠️ DO NOT use same email as seller/customer
  const phone = "9810812200";
  const role = "super-admin";
  const passwordPlain = "Alex@1988";     // Choose a strong password

  try {
    await client.connect();
    console.log("✅ Connected to MongoDB");

    const existing = await Users.findOne({ email: email.toLowerCase() });
    if (existing) {
      console.log("ℹ️ Super admin already exists:");
      console.log(existing);
      return;
    }

    const hashedPassword = await bcrypt.hash(passwordPlain, 10);

    const doc = {
      firstName,
      lastName,
      name: `${firstName} ${lastName}`,
      email: email.toLowerCase(),
      phone,
      role,               // super-admin
      status: "active",
      blocked: false,
      password: hashedPassword,

      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await Users.insertOne(doc);

    console.log("🎉 Super Admin created!");
    console.log("🆔 _id:", result.insertedId);
    console.log("📩 Email:", email);
    console.log("🔑 Password:", passwordPlain);
  } catch (err) {
    console.error("❌ Error creating super admin:", err);
  } finally {
    await client.close();
    console.log("🔚 Mongo connection closed");
  }
}

createSuperAdmin();
