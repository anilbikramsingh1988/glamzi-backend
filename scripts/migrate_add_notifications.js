// scripts/migrate_add_notifications.js
import { MongoClient, ServerApiVersion } from "mongodb";
import dotenv from "dotenv";

dotenv.config();

if (!process.env.MONGO_URI) {
  throw new Error("❌ Please set MONGO_URI in your .env file");
}

const client = new MongoClient(process.env.MONGO_URI, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

// ✅ Default notification settings for existing sellers
const DEFAULT_NOTIFICATIONS = {
  emailNewOrder: true,
  emailOrderCancellation: true,
  emailReturnRefund: true,
  emailPayoutProcessed: true,
  emailLowStock: false,
  smsNewOrder: false,
  inAppNotifications: true,
};

async function run() {
  try {
    console.log("⏳ Connecting to MongoDB...");
    await client.connect();

    const db = client.db("glamzi_ecommerce"); // ✅ same DB as in your app
    const collection = db.collection("seller_settings");

    console.log("⏳ Finding documents without 'notifications' field...");

    // Only docs that don't have notifications (or it's null)
    const filter = {
      $or: [{ notifications: { $exists: false } }, { notifications: null }],
    };

    const update = {
      $set: {
        notifications: DEFAULT_NOTIFICATIONS,
        updatedAt: new Date(),
      },
    };

    const result = await collection.updateMany(filter, update);

    console.log("✅ Migration complete!");
    console.log(`   Matched documents:  ${result.matchedCount}`);
    console.log(`   Modified documents: ${result.modifiedCount}`);
  } catch (err) {
    console.error("❌ Migration failed:", err);
  } finally {
    await client.close();
    console.log("🔚 MongoDB connection closed.");
  }
}

run();
