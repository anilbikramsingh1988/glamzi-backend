// backend/lib/mongo.js (ESM)
import { MongoClient } from "mongodb";

let _client = null;

function getMongoUri() {
  return process.env.MONGODB_URI || process.env.MONGO_URI || process.env.MONGO_URL;
}

function getDbName() {
  return process.env.MONGODB_DB || process.env.DB_NAME || process.env.MONGO_DB;
}

export function debugMongoEnv() {
  return {
    uri: process.env.MONGODB_URI || process.env.MONGO_URI || null,
    dbName: process.env.MONGODB_DB || process.env.DB_NAME || null,
  };
}

export async function getMongoClient() {
  if (_client) return _client;

  const uri = getMongoUri();
  if (!uri) throw new Error("Missing Mongo URI (set MONGO_URI or MONGODB_URI)");

  _client = new MongoClient(uri, {
    maxPoolSize: Number(process.env.MONGODB_MAX_POOL_SIZE || 20),
    minPoolSize: Number(process.env.MONGODB_MIN_POOL_SIZE || 0),
    retryWrites: true,
  });

  await _client.connect();
  return _client;
}

export async function getDB() {
  const client = await getMongoClient();
  const dbName = getDbName();
  if (!dbName) throw new Error("Missing DB name (set DB_NAME or MONGODB_DB)");
  return client.db(dbName);
}

export async function closeMongo() {
  if (_client) {
    await _client.close();
    _client = null;
  }
}
