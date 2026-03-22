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

function cosineSimilarity(a: number[], b: number[]): number {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dotProduct / denom;
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

  const [memory] = await sql`
    INSERT INTO memories (api_key_id, agent_id, user_id, org_id, scope, content, tags, embedding)
    VALUES (${apiKeyId}, ${agentId}, ${userId || null}, ${orgId || null}, ${scope}, ${content}, ${tags}, ${JSON.stringify(vector)}::jsonb)
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

  const queryVector = await embed(query);

  // Build scope conditions using parameterized queries
  let scopeCondition: string;
  if (scope === "org" && orgId) {
    scopeCondition = userId
      ? `AND (agent_id = ${sql`${agentId}`} OR (scope = 'org' AND org_id = ${sql`${orgId}`}) OR (scope = 'user' AND user_id = ${sql`${userId}`}))`
      : `AND (agent_id = ${sql`${agentId}`} OR (scope = 'org' AND org_id = ${sql`${orgId}`}))`;
  } else if (scope === "user" && userId) {
    scopeCondition = `AND (agent_id = ${sql`${agentId}`} OR (scope = 'user' AND user_id = ${sql`${userId}`}))`;
  } else {
    scopeCondition = `AND agent_id = ${sql`${agentId}`}`;
  }

  // Fetch candidate memories with embeddings
  const candidates = await sql.unsafe(`
    SELECT
      id, agent_id, user_id, org_id, scope, content, tags, embedding, created_at, updated_at
    FROM memories
    WHERE api_key_id = '${apiKeyId}'
      AND deleted_at IS NULL
      AND embedding IS NOT NULL
      AND agent_id = '${agentId}'
    ORDER BY created_at DESC
    LIMIT 500
  `);

  // Also fetch scope-expanded memories if needed
  let scopeMemories: any[] = [];
  if (scope === "org" && orgId) {
    scopeMemories = await sql.unsafe(`
      SELECT
        id, agent_id, user_id, org_id, scope, content, tags, embedding, created_at, updated_at
      FROM memories
      WHERE api_key_id = '${apiKeyId}'
        AND deleted_at IS NULL
        AND embedding IS NOT NULL
        AND scope = 'org' AND org_id = '${orgId}'
        AND agent_id != '${agentId}'
      ORDER BY created_at DESC
      LIMIT 200
    `);
  } else if (scope === "user" && userId) {
    scopeMemories = await sql.unsafe(`
      SELECT
        id, agent_id, user_id, org_id, scope, content, tags, embedding, created_at, updated_at
      FROM memories
      WHERE api_key_id = '${apiKeyId}'
        AND deleted_at IS NULL
        AND embedding IS NOT NULL
        AND scope = 'user' AND user_id = '${userId}'
        AND agent_id != '${agentId}'
      ORDER BY created_at DESC
      LIMIT 200
    `);
  }

  const allCandidates = [...(candidates as any[]), ...(scopeMemories as any[])];

  // Filter by tags if specified
  let filtered = allCandidates;
  if (tags && tags.length > 0) {
    filtered = allCandidates.filter((m: any) => {
      const memTags = m.tags || [];
      return tags.some((t) => memTags.includes(t));
    });
  }

  // Compute cosine similarity in app layer
  const scored: MemoryWithScore[] = filtered.map((m: any) => {
    const emb = typeof m.embedding === "string" ? JSON.parse(m.embedding) : m.embedding;
    const score = cosineSimilarity(queryVector, emb);
    return {
      id: m.id,
      agent_id: m.agent_id,
      user_id: m.user_id,
      org_id: m.org_id,
      scope: m.scope,
      content: m.content,
      tags: m.tags,
      created_at: m.created_at,
      updated_at: m.updated_at,
      relevance_score: Math.round(score * 1000) / 1000,
    };
  });

  // Sort by relevance and return top results
  scored.sort((a, b) => b.relevance_score - a.relevance_score);

  // Track usage
  await sql`
    INSERT INTO usage_events (api_key_id, event_type, agent_id, tokens)
    VALUES (${apiKeyId}, 'recall', ${agentId}, ${embeddingTokenEstimate(query)})
  `;

  return scored.slice(0, limit);
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
