import fs from "fs";
import path from "path";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const MODE = (process.env.REPORT_STORAGE_MODE || "local").toLowerCase();
const LOCAL_DIR = process.env.REPORT_LOCAL_DIR || "reports";
const PUBLIC_BASE = process.env.REPORT_PUBLIC_BASE_URL || "";

function getS3Client() {
  const endpoint = process.env.S3_ENDPOINT;
  const region = process.env.S3_REGION || "auto";
  const accessKeyId = process.env.S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;

  if (!endpoint || !accessKeyId || !secretAccessKey) {
    throw new Error("Missing S3 credentials");
  }

  return new S3Client({
    region,
    endpoint,
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: true,
  });
}

export async function saveReport({ buffer, key }) {
  if (!buffer || !key) throw new Error("Report buffer and key are required");

  if (MODE === "s3") {
    const bucket = process.env.S3_BUCKET;
    if (!bucket) throw new Error("Missing S3_BUCKET");
    const client = getS3Client();
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: buffer,
        ContentType: "application/pdf",
      })
    );
    const base = PUBLIC_BASE || endpointToPublic(process.env.S3_PUBLIC_BASE || "");
    const url = base ? `${base.replace(/\/$/, "")}/${key}` : "";
    return { key, url };
  }

  const dir = path.resolve(LOCAL_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, key);
  fs.writeFileSync(filePath, buffer);

  const url = PUBLIC_BASE
    ? `${PUBLIC_BASE.replace(/\/$/, "")}/${key}`
    : "";
  return { key, url };
}

function endpointToPublic(base) {
  if (!base) return "";
  return base.replace(/\/$/, "");
}
