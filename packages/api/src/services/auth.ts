import { createHash, randomBytes } from "crypto";
import { sql } from "../db/connection.js";

const KEY_PREFIX = "ci_sk_";

export function generateApiKey(): { key: string; hash: string; prefix: string } {
  const raw = randomBytes(32).toString("base64url");
  const key = `${KEY_PREFIX}${raw}`;
  const hash = hashKey(key);
  const prefix = key.slice(0, KEY_PREFIX.length + 8);
  return { key, hash, prefix };
}

export function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export interface ApiKeyRecord {
  id: string;
  org_id: string | null;
  tier: string;
}

export async function validateApiKey(
  key: string,
): Promise<ApiKeyRecord | null> {
  const hash = hashKey(key);
  const [record] = await sql`
    SELECT id, org_id, tier
    FROM api_keys
    WHERE key_hash = ${hash} AND revoked_at IS NULL
  `;
  return (record as unknown as ApiKeyRecord) || null;
}

export async function revokeApiKey(apiKeyId: string): Promise<void> {
  await sql`
    UPDATE api_keys SET revoked_at = now() WHERE id = ${apiKeyId}
  `;
}

export async function createApiKey(
  name: string,
  orgId?: string,
): Promise<{ key: string; id: string }> {
  const { key, hash, prefix } = generateApiKey();
  const [record] = await sql`
    INSERT INTO api_keys (key_hash, key_prefix, name, org_id)
    VALUES (${hash}, ${prefix}, ${name}, ${orgId || null})
    RETURNING id
  `;
  return { key, id: (record as unknown as { id: string }).id };
}
