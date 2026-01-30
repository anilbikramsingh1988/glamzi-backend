import { MongoClient } from "mongodb";
import dotenv from "dotenv";

dotenv.config();

const MONGO_URI = process.env.MONGO_URI;
const DB_NAME = process.env.DB_NAME || "glamzi_email";

if (!MONGO_URI) {
  throw new Error("MONGO_URI is required for email service");
}

export const client = new MongoClient(MONGO_URI, {
  maxPoolSize: Number(process.env.MONGO_POOL_SIZE || 10),
});

export async function connectDb() {
  if (!client.topology || !client.topology.isConnected()) {
    await client.connect();
  }
  return client.db(DB_NAME);
}

export { DB_NAME };
