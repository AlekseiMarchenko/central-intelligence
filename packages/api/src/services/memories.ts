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

// --- Vector similarity ---

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

// --- Temporal decay ---

function temporalDecay(createdAt: string, halfLifeDays: number = 90): number {
  const ageMs = Date.now() - new Date(createdAt).getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  // Exponential decay: score halves every halfLifeDays
  // Recent memories (~0 days) ≈ 1.0, 90 days old ≈ 0.5, 180 days ≈ 0.25
  return Math.pow(0.5, ageDays / halfLifeDays);
}

// --- Reciprocal Rank Fusion ---

function reciprocalRankFusion(
  rankedLists: { id: string; rank: number }[][],
  k: number = 60
): Map<string, number> {
  const scores = new Map<string, number>();
  for (const list of rankedLists) {
    for (const item of list) {
      const current = scores.get(item.id) || 0;
      scores.set(item.id, current + 1 / (k + item.rank));
    }
  }
  return scores;
}

// --- BM25 full-text search ---

async function bm25Search(
  apiKeyId: string,
  agentId: string,
  query: string,
  limit: number = 50
): Promise<{ id: string; rank: number }[]> {
  try {
    // Use plainto_tsquery for safe query parsing (no special syntax needed)
    const results = await sql`
      SELECT id,
        ts_rank_cd(content_tsv, plainto_tsquery('english', ${query})) as bm25_score
      FROM memories
      WHERE api_key_id = ${apiKeyId}
        AND agent_id = ${agentId}
        AND deleted_at IS NULL
        AND content_tsv @@ plainto_tsquery('english', ${query})
      ORDER BY bm25_score DESC
      LIMIT ${limit}
    `;
    return results.map((r: any, i: number) => ({ id: r.id, rank: i + 1 }));
  } catch {
    // content_tsv column might not exist yet (pre-migration)
    return [];
  }
}

// --- Trigram fuzzy search (catches typos and partial matches) ---

async function trigramSearch(
  apiKeyId: string,
  agentId: string,
  query: string,
  limit: number = 30
): Promise<{ id: string; rank: number }[]> {
  try {
    const results = await sql`
      SELECT id,
        similarity(content, ${query}) as trgm_score
      FROM memories
      WHERE api_key_id = ${apiKeyId}
        AND agent_id = ${agentId}
        AND deleted_at IS NULL
        AND similarity(content, ${query}) > 0.1
      ORDER BY trgm_score DESC
      LIMIT ${limit}
    `;
    return results.map((r: any, i: number) => ({ id: r.id, rank: i + 1 }));
  } catch {
    // pg_trgm might not be available
    return [];
  }
}

// --- Context compression ---

async function compressContext(memories: MemoryWithScore[], query: string): Promise<MemoryWithScore[]> {
  // Only compress if total content exceeds ~4000 tokens (~16000 chars)
  const totalChars = memories.reduce((sum, m) => sum + m.content.length, 0);
  if (totalChars < 16000) return memories;

  try {
    const OpenAI = (await import("openai")).default;
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    // Use GPT-4o-mini for cheap compression
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: "Compress the following memories into concise summaries. Keep only information relevant to the query. Preserve key facts, decisions, and technical details. Return a JSON array of {id, summary} objects.",
        },
        {
          role: "user",
          content: `Query: ${query}\n\nMemories:\n${memories.map((m) => `[${m.id}]: ${m.content}`).join("\n\n")}`,
        },
      ],
      response_format: { type: "json_object" },
      max_tokens: 2000,
    });

    const parsed = JSON.parse(response.choices[0].message.content || "{}");
    const summaries = parsed.summaries || parsed.memories || [];

    if (Array.isArray(summaries) && summaries.length > 0) {
      const summaryMap = new Map(summaries.map((s: any) => [s.id, s.summary]));
      return memories.map((m) => ({
        ...m,
        content: (summaryMap.get(m.id) as string) || m.content,
      }));
    }
  } catch (err: any) {
    console.warn("[compress] Context compression failed, returning raw:", err.message);
  }

  return memories;
}

// --- Store ---

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
    INSERT INTO memories (api_key_id, agent_id, user_id, org_id, scope, content, tags, embedding, content_tsv)
    VALUES (
      ${apiKeyId}, ${agentId}, ${userId || null}, ${orgId || null}, ${scope},
      ${content}, ${tags}, ${JSON.stringify(vector)}::jsonb,
      to_tsvector('english', ${content})
    )
    RETURNING id, agent_id, user_id, org_id, scope, content, tags, created_at, updated_at
  `;

  // Track usage
  await sql`
    INSERT INTO usage_events (api_key_id, event_type, agent_id, tokens)
    VALUES (${apiKeyId}, 'remember', ${agentId}, ${embeddingTokenEstimate(content)})
  `;

  return memory as unknown as Memory;
}

// --- Recall (hybrid retrieval) ---

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

  // === Strategy 1: Vector search (semantic) ===
  const candidates = await sql`
    SELECT
      id, agent_id, user_id, org_id, scope, content, tags, embedding, created_at, updated_at
    FROM memories
    WHERE api_key_id = ${apiKeyId}
      AND deleted_at IS NULL
      AND embedding IS NOT NULL
      AND agent_id = ${agentId}
    ORDER BY created_at DESC
    LIMIT 500
  `;

  // Also fetch scope-expanded memories
  let scopeMemories: any[] = [];
  if (scope === "org" && orgId) {
    scopeMemories = await sql`
      SELECT
        id, agent_id, user_id, org_id, scope, content, tags, embedding, created_at, updated_at
      FROM memories
      WHERE api_key_id = ${apiKeyId}
        AND deleted_at IS NULL
        AND embedding IS NOT NULL
        AND scope = 'org' AND org_id = ${orgId}
        AND agent_id != ${agentId}
      ORDER BY created_at DESC
      LIMIT 200
    `;
  } else if (scope === "user" && userId) {
    scopeMemories = await sql`
      SELECT
        id, agent_id, user_id, org_id, scope, content, tags, embedding, created_at, updated_at
      FROM memories
      WHERE api_key_id = ${apiKeyId}
        AND deleted_at IS NULL
        AND embedding IS NOT NULL
        AND scope = 'user' AND user_id = ${userId}
        AND agent_id != ${agentId}
      ORDER BY created_at DESC
      LIMIT 200
    `;
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

  // Compute vector similarities and build ranked list
  const vectorScores = new Map<string, number>();
  const memoryMap = new Map<string, any>();

  filtered.forEach((m: any) => {
    const emb = typeof m.embedding === "string" ? JSON.parse(m.embedding) : m.embedding;
    const score = cosineSimilarity(queryVector, emb);
    vectorScores.set(m.id, score);
    memoryMap.set(m.id, m);
  });

  const vectorRanked = [...vectorScores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id], i) => ({ id, rank: i + 1 }));

  // === Strategy 2: BM25 full-text search ===
  const bm25Ranked = await bm25Search(apiKeyId, agentId, query, 50);

  // Add any BM25-only results to memoryMap (they might not be in the vector set)
  for (const item of bm25Ranked) {
    if (!memoryMap.has(item.id)) {
      const [mem] = await sql`
        SELECT id, agent_id, user_id, org_id, scope, content, tags, embedding, created_at, updated_at
        FROM memories WHERE id = ${item.id}
      `;
      if (mem) memoryMap.set(item.id, mem);
    }
  }

  // === Strategy 3: Trigram fuzzy search ===
  const trigramRanked = await trigramSearch(apiKeyId, agentId, query, 30);

  for (const item of trigramRanked) {
    if (!memoryMap.has(item.id)) {
      const [mem] = await sql`
        SELECT id, agent_id, user_id, org_id, scope, content, tags, embedding, created_at, updated_at
        FROM memories WHERE id = ${item.id}
      `;
      if (mem) memoryMap.set(item.id, mem);
    }
  }

  // === Reciprocal Rank Fusion ===
  const rankedLists = [vectorRanked, bm25Ranked, trigramRanked].filter(
    (list) => list.length > 0
  );

  let fusedScores: Map<string, number>;
  if (rankedLists.length > 1) {
    fusedScores = reciprocalRankFusion(rankedLists);
  } else {
    // Fallback to vector-only if BM25/trigram aren't available
    fusedScores = new Map(vectorRanked.map((item) => [item.id, vectorScores.get(item.id) || 0]));
  }

  // === Apply temporal decay ===
  const finalScored: MemoryWithScore[] = [];
  for (const [id, rrfScore] of fusedScores.entries()) {
    const m = memoryMap.get(id);
    if (!m) continue;

    const decay = temporalDecay(m.created_at);
    // Blend: 85% retrieval relevance + 15% recency
    const finalScore = rrfScore * 0.85 + decay * rrfScore * 0.15;

    finalScored.push({
      id: m.id,
      agent_id: m.agent_id,
      user_id: m.user_id,
      org_id: m.org_id,
      scope: m.scope,
      content: m.content,
      tags: m.tags,
      created_at: m.created_at,
      updated_at: m.updated_at,
      relevance_score: Math.round(finalScore * 10000) / 10000,
    });
  }

  // Sort by final score
  finalScored.sort((a, b) => b.relevance_score - a.relevance_score);

  // === Context compression (if results are large) ===
  const topResults = finalScored.slice(0, limit);
  const compressed = await compressContext(topResults, query);

  // Track usage
  await sql`
    INSERT INTO usage_events (api_key_id, event_type, agent_id, tokens)
    VALUES (${apiKeyId}, 'recall', ${agentId}, ${embeddingTokenEstimate(query)})
  `;

  return compressed;
}

// --- Forget ---

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

// --- Share ---

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
