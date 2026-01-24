import { MongoClient } from 'mongodb';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
dotenv.config();

const uri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017';
const client = new MongoClient(uri);

async function run() {
  await client.connect();
  const db = client.db('myEcommerce');
  const users = db.collection('users');

  const email = process.argv[2] || 'admin@example.com';
  const password = process.argv[3] || 'Admin123!';
  const name = process.argv[4] || 'Administrator';

  const lower = email.toLowerCase();
  const exists = await users.findOne({ email: lower });
  if (exists) {
    console.log('User already exists. Updating role to admin.');
    await users.updateOne({ _id: exists._id }, { $set: { role: 'admin' } });
    console.log('Updated existing user to admin:', lower);
  } else {
    const hash = await bcrypt.hash(password, 10);
    const doc = { name, email: lower, password: hash, role: 'admin', createdAt: new Date(), blocked: false };
    const r = await users.insertOne(doc);
    console.log('Created admin user:', lower, 'id:', r.insertedId.toString());
  }

  await client.close();
}

run().catch(err => { console.error(err); process.exit(1); });
