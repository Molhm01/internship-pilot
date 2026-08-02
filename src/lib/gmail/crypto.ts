import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

// Gmail OAuth tokens are the one credential this app stores that grants
// access to a real external account (read-only, but still real). They're
// encrypted at rest with a key derived from a local-only secret — never the
// plaintext token, and never logged. This does not protect against someone
// with full access to this machine (nothing local-only can), but it does
// mean the token isn't sitting in dev.db as a plain string that any casual
// DB viewer or backup tool would see.
function getKey(): Buffer {
  const secret = process.env.GMAIL_TOKEN_ENCRYPTION_KEY;
  if (!secret) {
    throw new Error(
      "GMAIL_TOKEN_ENCRYPTION_KEY is not set in .env. Generate one (any long random string) before connecting Gmail.",
    );
  }
  return scryptSync(secret, "internship-pilot-gmail-token", 32);
}

export function encryptToken(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString("base64");
}

export function decryptToken(encoded: string): string {
  const key = getKey();
  const raw = Buffer.from(encoded, "base64");
  const iv = raw.subarray(0, 12);
  const authTag = raw.subarray(12, 28);
  const encrypted = raw.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf-8");
}
