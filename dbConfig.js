// dbConfig.js
import dotenv from "dotenv";
import { MongoClient } from "mongodb";

dotenv.config();

const uri = process.env.MONGO_URI;
const DB_NAME = process.env.DB_NAME || "everest_logistic";

let cached = global.__mongoClient;
if (!cached) cached = global.__mongoClient = { client: null, db: null };

const client = cached.client || new MongoClient(uri);
if (!cached.client) cached.client = client;

export async function getDB() {
  if (cached.db) return cached.db;

  await client.connect();

  cached.db = client.db(DB_NAME);
  console.log("[DB] connected", { dbName: cached.db.databaseName });
  return cached.db;
}

export { client };
