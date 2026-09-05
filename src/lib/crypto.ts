/**
 * Symmetric encryption for OAuth access/refresh tokens at rest.
 *
 * Per section 36 ("Encrypt OAuth tokens") and section 25 ("OAuth tokens
 * must be securely stored/encrypted"), raw tokens are never written to the
 * database — only the output of `encrypt()` is. `OAUTH_TOKEN_ENCRYPTION_KEY`
 * must be a 32-byte key expressed as 64 hex characters
 * (generate with: openssl rand -hex 32).
 */
import crypto from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH_BYTES = 12;

function getKey(): Buffer {
  const hex = process.env.OAUTH_TOKEN_ENCRYPTION_KEY;
  if (!hex) {
    throw new Error(
      "OAUTH_TOKEN_ENCRYPTION_KEY is not set. Generate one with `openssl rand -hex 32` and set it in .env",
    );
  }
  const key = Buffer.from(hex, "hex");
  if (key.length !== 32) {
    throw new Error("OAUTH_TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes (64 hex characters)");
  }
  return key;
}

/**
 * Encrypts a plaintext string. Output format: "iv:authTag:ciphertext" (all hex).
 */
export function encrypt(plaintext: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString("hex"), authTag.toString("hex"), encrypted.toString("hex")].join(":");
}

/**
 * Decrypts a string produced by `encrypt()`. Throws if the ciphertext is
 * malformed or has been tampered with (GCM auth tag verification fails).
 */
export function decrypt(ciphertext: string): string {
  const key = getKey();
  const parts = ciphertext.split(":");
  if (parts.length !== 3) {
    throw new Error("Malformed ciphertext: expected format iv:authTag:data");
  }
  const [ivHex, tagHex, dataHex] = parts as [string, string, string];
  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(tagHex, "hex");
  const data = Buffer.from(dataHex, "hex");

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  return decrypted.toString("utf8");
}
