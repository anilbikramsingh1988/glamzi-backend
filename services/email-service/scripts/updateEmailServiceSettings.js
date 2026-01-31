import { connectDb } from "../db.js";

const payload = {
  brandName: "Glamzi",
  brandPrimaryColor: "#F22A83",
  brandSecondaryColor: "#FFE3F0",
  brandLogoUrl: "https://glamzibeauty.com/assets/logo-2cb1acee.webp",
  supportEmail: "support@glamzibeauty.com",
  supportPhone: "+977-9810812200",
  address: "Kathmandu, Nepal",
  footerNotice: "✓ FREE DELIVERY ✓ FREE RETURNS",
  quietHours: {
    enabled: true,
    start: "22:00",
    end: "07:00",
    startHour: 22,
    endHour: 7,
    timeZone: "Asia/Kathmandu",
  },
  defaultLanguage: "en",
};

const db = await connectDb();
const now = new Date();

const existing = await db.collection("emailSettings").findOne({ _id: "default" });

await db.collection("emailSettings").updateOne(
  { _id: "default" },
  {
    $set: {
      ...payload,
      updatedAt: now,
    },
    $setOnInsert: {
      createdAt: now,
    },
  },
  { upsert: true }
);

console.log("Updated emailSettings with brand defaults.");
process.exit(0);
