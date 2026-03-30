import { createCipheriv, createDecipheriv, randomBytes, createHash } from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const ENCRYPTION_PREFIX = "enc:v1:";

/**
 * Derive a 256-bit encryption key from the raw API key.
 * Uses SHA-256 with a salt — deterministic so the same key always decrypts.
 */
function deriveKey(apiKey: string): Buffer {
  return createHash("sha256")
    .update(`ci-memory-encryption:${apiKey}`)
    .digest();
}

/**
 * Encrypt plaintext content using AES-256-GCM.
 * Returns: "enc:v1:<iv_hex>:<ciphertext_hex>:<authTag_hex>"
 */
export function encrypt(plaintext: string, apiKey: string): string {
  const key = deriveKey(apiKey);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });

  let encrypted = cipher.update(plaintext, "utf8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag().toString("hex");

  return `${ENCRYPTION_PREFIX}${iv.toString("hex")}:${encrypted}:${authTag}`;
}

/**
 * Decrypt content encrypted by encrypt().
 * Returns the original plaintext.
 */
export function decrypt(ciphertext: string, apiKey: string): string {
  if (!isEncrypted(ciphertext)) {
    // Not encrypted — return as-is (backwards compatibility)
    return ciphertext;
  }

  const key = deriveKey(apiKey);
  const withoutPrefix = ciphertext.slice(ENCRYPTION_PREFIX.length);
  const [ivHex, encryptedHex, authTagHex] = withoutPrefix.split(":");

  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");
  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encryptedHex, "hex", "utf8");
  decrypted += decipher.final("utf8");

  return decrypted;
}

/**
 * Check if content is encrypted (has our prefix).
 */
export function isEncrypted(content: string): boolean {
  return content.startsWith(ENCRYPTION_PREFIX);
}
