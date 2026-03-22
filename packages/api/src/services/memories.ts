import { sql } from "../db/connection.js";
import { embed, embeddingTokenEstimate } from "./embeddings.js";

export interface Memory {
  id: string;
  agent_id: string;
  user_id: string | null;
  org_id: string | null;
  scope: "agent" | "user" | "org";
  content: string;
  tags: string[];
  created_at: string;
  updated_at: string;
}

export interface MemoryWithScore extends Memory {
  relevance_score: number;
}

interface StoreParams {
  apiKeyId: string;
  agentId: string;
  userId?: string;
  orgId?: string;
  scope?: "agent" | "user" | "org";
  content: string;
  tags?: string[];
}

interface RecallParams {
  apiKeyId: string;
  agentId: string;
  userId?: string;
  orgId?: string;
  query: string;
  scope?: "agent" | "user" | "org";
  tags?: string[];
  limit?: number;
}

export async function store(params: StoreParams): Promise<Memory> {
  const {
    apiKeyId,
    agentId,
    userId,
    orgId,
    scope = "agent",
    content,
    tags = [],
  } = params;

  const vector = await embed(content);
  const vectorStr = `[${vector.join(",")}]`;

  const [memory] = await sql`
    INSERT INTO memories (api_key_id, agent_id, user_id, org_id, scope, content, tags, embedding)
    VALUES (${apiKeyId}, ${agentId}, ${userId || null}, ${orgId || null}, ${scope}, ${content}, ${tags}, ${vectorStr}::vector)
    RETURNING id, agent_id, user_id, org_id, scope, content, tags, created_at, updated_at
  `;

  // Track usage
  await sql`
    INSERT INTO usage_events (api_key_id, event_type, agent_id, tokens)
    VALUES (${apiKeyId}, 'remember', ${agentId}, ${embeddingTokenEstimate(content)})
  `;

  return memory as unknown as Memory;
}

export async function recall(params: RecallParams): Promise<MemoryWithScore[]> {
  const {
    apiKeyId,
    agentId,
    userId,
    orgId,
    query,
    scope,
    tags,
    limit = 10,
  } = params;

  const vector = await embed(query);
  const vectorStr = `[${vector.join(",")}]`;

  // Build scope filter: agent always sees own memories + broader scopes they have access to
  let scopeFilter: string;
  if (scope === "org" && orgId) {
    scopeFilter = `AND (
      (agent_id = '${agentId}')
      OR (scope = 'org' AND org_id = '${orgId}')
      ${userId ? `OR (scope = 'user' AND user_id = '${userId}')` : ""}
    )`;
  } else if (scope === "user" && userId) {
    scopeFilter = `AND (
      (agent_id = '${agentId}')
      OR (scope = 'user' AND user_id = '${userId}')
    )`;
  } else {
    scopeFilter = `AND agent_id = '${agentId}'`;
  }

  const tagFilter =
    tags && tags.length > 0
      ? `AND tags && ARRAY[${tags.map((t) => `'${t}'`).join(",")}]::text[]`
      : "";

  const memories = await sql.unsafe(`
    SELECT
      id, agent_id, user_id, org_id, scope, content, tags, created_at, updated_at,
      1 - (embedding <=> '${vectorStr}'::vector) AS relevance_score
    FROM memories
    WHERE api_key_id = '${apiKeyId}'
      AND deleted_at IS NULL
      ${scopeFilter}
      ${tagFilter}
    ORDER BY embedding <=> '${vectorStr}'::vector
    LIMIT ${limit}
  `);

  // Track usage
  await sql`
    INSERT INTO usage_events (api_key_id, event_type, agent_id, tokens)
    VALUES (${apiKeyId}, 'recall', ${agentId}, ${embeddingTokenEstimate(query)})
  `;

  return memories as unknown as MemoryWithScore[];
}

export async function forget(
  apiKeyId: string,
  memoryId: string,
): Promise<boolean> {
  const result = await sql`
    UPDATE memories
    SET deleted_at = now()
    WHERE id = ${memoryId} AND api_key_id = ${apiKeyId} AND deleted_at IS NULL
    RETURNING id
  `;
  return result.length > 0;
}

export async function share(
  apiKeyId: string,
  memoryId: string,
  targetScope: "user" | "org",
  userId?: string,
  orgId?: string,
): Promise<boolean> {
  const updates: Record<string, string | undefined> = { scope: targetScope };
  if (targetScope === "user" && userId) updates.user_id = userId;
  if (targetScope === "org" && orgId) updates.org_id = orgId;

  const result = await sql`
    UPDATE memories
    SET scope = ${targetScope},
        user_id = COALESCE(${userId || null}, user_id),
        org_id = COALESCE(${orgId || null}, org_id),
        updated_at = now()
    WHERE id = ${memoryId} AND api_key_id = ${apiKeyId} AND deleted_at IS NULL
    RETURNING id
  `;
  return result.length > 0;
}
