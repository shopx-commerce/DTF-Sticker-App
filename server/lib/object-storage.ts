import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

// R2 is S3-compatible — the AWS SDK just points `endpoint` at R2 instead of AWS.

// Shared upload cap for every multer instance that accepts designs/gang-sheet files.
export const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} must be set to use object storage (Cloudflare R2)`);
  }
  return value;
}

let client: S3Client | null = null;
function getClient(): S3Client {
  if (client) return client;
  const accountId = required("R2_ACCOUNT_ID");
  client = new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: required("R2_ACCESS_KEY_ID"),
      secretAccessKey: required("R2_SECRET_ACCESS_KEY"),
    },
  });
  return client;
}

function bucketName(): string {
  return required("R2_BUCKET_NAME");
}

export async function putObject(key: string, body: Buffer, contentType: string): Promise<void> {
  await getClient().send(
    new PutObjectCommand({ Bucket: bucketName(), Key: key, Body: body, ContentType: contentType })
  );
}

export async function deleteObject(key: string): Promise<void> {
  await getClient().send(new DeleteObjectCommand({ Bucket: bucketName(), Key: key }));
}

// Fetches bytes server-side, for the same-origin proxy route — R2's URLs don't send CORS headers for a direct fetch().
export async function getObject(key: string): Promise<{ body: Buffer; contentType: string }> {
  const result = await getClient().send(new GetObjectCommand({ Bucket: bucketName(), Key: key }));
  const bytes = await result.Body!.transformToByteArray();
  return { body: Buffer.from(bytes), contentType: result.ContentType || "application/octet-stream" };
}

// Public URL if R2_PUBLIC_URL is set, else a short-lived signed URL (the safer default).
export async function getObjectUrl(key: string): Promise<string> {
  const publicBase = process.env.R2_PUBLIC_URL;
  if (publicBase) {
    return `${publicBase.replace(/\/$/, "")}/${key}`;
  }
  const command = new GetObjectCommand({ Bucket: bucketName(), Key: key });
  return getSignedUrl(getClient(), command, { expiresIn: 3600 }); // 1 hour
}
