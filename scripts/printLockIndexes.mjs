import "dotenv/config";
import { getDB, closeMongo } from "../lib/mongo.js";

const db = await getDB();
const idx = await db.collection("gl_locks").indexes();
console.log(JSON.stringify({ indexes: idx }, null, 2));
await closeMongo();
