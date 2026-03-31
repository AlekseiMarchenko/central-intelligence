import { sql } from "../db/connection.js";
import { embed, embeddingTokenEstimate } from "./embeddings.js";
import { encrypt, decrypt, isEncrypted } from "./encryption.js";

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
  rawApiKey: string;
  agentId: string;
  userId?: string;
  orgId?: string;
  scope?: "agent" | "user" | "org";
  content: string;
  tags?: string[];
}

interface RecallParams {
  apiKeyId: string;
  rawApiKey: string;
  agentId: string;
  userId?: string;
  orgId?: string;
  query: string;
  scope?: "agent" | "user" | "org";
  tags?: string[];
  limit?: number;
}

// --- Vector similarity ---

export function cosineSimilarity(a: number[], b: number[]): number {
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

export function temporalDecay(createdAt: string, halfLifeDays: number = 90): number {
  const ageMs = Date.now() - new Date(createdAt).getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  // Exponential decay: score halves every halfLifeDays
  // Recent memories (~0 days) ≈ 1.0, 90 days old ≈ 0.5, 180 days ≈ 0.25
  return Math.pow(0.5, ageDays / halfLifeDays);
}

// --- Reciprocal Rank Fusion ---

export function reciprocalRankFusion(
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
  limit: number = 50,
  includeShared: boolean = false
): Promise<{ id: string; rank: number }[]> {
  try {
    // Use plainto_tsquery for safe query parsing (no special syntax needed)
    const results = includeShared
      ? await sql`
          SELECT id,
            ts_rank_cd(content_tsv, plainto_tsquery('english', ${query})) as bm25_score
          FROM memories
          WHERE api_key_id = ${apiKeyId}
            AND deleted_at IS NULL
            AND content_tsv @@ plainto_tsquery('english', ${query})
            AND (agent_id = ${agentId} OR scope IN ('user', 'org'))
          ORDER BY bm25_score DESC
          LIMIT ${limit}
        `
      : await sql`
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
  } catch (err: any) {
    // Only swallow "column not found" errors (pre-migration).
    // Re-throw everything else (connection errors, OOM, etc.)
    if (err.code === "42703" || err.message?.includes("content_tsv")) {
      console.warn("[bm25] content_tsv column not found (pre-migration), skipping BM25 search");
      return [];
    }
    console.error("[bm25] BM25 search failed:", err.message);
    throw err;
  }
}

// Trigram search removed: it operated on encrypted content (AES-256-GCM ciphertext),
// producing meaningless similarity scores. Vector + BM25 is sufficient for hybrid retrieval.

// Context compression removed: it sent decrypted memory content to OpenAI GPT-4o-mini,
// contradicting the encryption-at-rest guarantee. Clients handle summarization if needed.

// --- Store ---

export async function store(params: StoreParams): Promise<Memory> {
  const {
    apiKeyId,
    rawApiKey,
    agentId,
    userId,
    orgId,
    scope = "agent",
    content,
    tags = [],
  } = params;

  // Generate embedding from plaintext BEFORE encryption
  const vector = await embed(content);

  // Encrypt content at rest
  const encryptedContent = encrypt(content, rawApiKey);

  // Generate tsvector from plaintext BEFORE encryption for BM25 search.
  // This leaks word stems (not full content) — accepted tradeoff for search functionality.
  const [memory] = await sql`
    INSERT INTO memories (api_key_id, agent_id, user_id, org_id, scope, content, tags, embedding, content_tsv)
    VALUES (
      ${apiKeyId}, ${agentId}, ${userId || null}, ${orgId || null}, ${scope},
      ${encryptedContent}, ${tags}, ${JSON.stringify(vector)}::jsonb,
      to_tsvector('english', ${content})
    )
    RETURNING id, agent_id, user_id, org_id, scope, content, tags, created_at, updated_at
  `;

  // Return decrypted content to the caller
  const result = memory as unknown as Memory;
  result.content = content;

  // Track usage
  await sql`
    INSERT INTO usage_events (api_key_id, event_type, agent_id, tokens)
    VALUES (${apiKeyId}, 'remember', ${agentId}, ${embeddingTokenEstimate(content)})
  `;

  return result;
}

// --- Recall (hybrid retrieval: vector + BM25 + RRF + temporal decay) ---
//
//   Query ──embed──> Vector Search (cosine sim against all memories)
//     │                    │
//     └──tsquery──> BM25 Search (full-text against content_tsv)
//                         │
//                    ┌────┴────┐
//                    │  RRF    │  Reciprocal Rank Fusion (k=60)
//                    └────┬────┘
//                         │
//                    Temporal Decay (85% relevance + 15% recency)
//                         │
//                    Quality Gate (min vector similarity 0.25)
//                         │
//                    Decrypt + Return

export async function recall(params: RecallParams): Promise<MemoryWithScore[]> {
  const {
    apiKeyId,
    rawApiKey,
    agentId,
    userId,
    orgId,
    query,
    scope,
    tags,
    limit = 10,
  } = params;

  const queryVector = await embed(query);

  // Determine if we should include shared (user/org scope) memories
  const includeShared = scope !== "agent";

  // === Strategy 1: Vector search (semantic) ===
  // Always fetch agent's own memories
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

  // Also fetch shared memories (user/org scope from other agents)
  let scopeMemories: any[] = [];
  if (includeShared) {
    scopeMemories = await sql`
      SELECT
        id, agent_id, user_id, org_id, scope, content, tags, embedding, created_at, updated_at
      FROM memories
      WHERE api_key_id = ${apiKeyId}
        AND deleted_at IS NULL
        AND embedding IS NOT NULL
        AND scope IN ('user', 'org')
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
  const bm25Ranked = await bm25Search(apiKeyId, agentId, query, 50, includeShared);

  // Batch-fetch BM25-only results not already in memoryMap
  const missingBm25Ids = bm25Ranked
    .filter((item) => !memoryMap.has(item.id))
    .map((item) => item.id);

  if (missingBm25Ids.length > 0) {
    const bm25Memories = await sql`
      SELECT id, agent_id, user_id, org_id, scope, content, tags, embedding, created_at, updated_at
      FROM memories WHERE id = ANY(${missingBm25Ids})
    `;
    for (const mem of bm25Memories) {
      memoryMap.set((mem as any).id, mem);
    }
  }

  // === Reciprocal Rank Fusion ===
  const rankedLists = [vectorRanked, bm25Ranked].filter(
    (list) => list.length > 0
  );

  let fusedScores: Map<string, number>;
  if (rankedLists.length > 1) {
    fusedScores = reciprocalRankFusion(rankedLists);
  } else {
    // Fallback to vector-only if BM25 isn't available
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

  // === Minimum relevance threshold ===
  const MIN_VECTOR_SIMILARITY = 0.25;
  const relevantResults = finalScored.filter((m) => {
    const mem = memoryMap.get(m.id);
    if (!mem) return false;

    // If this memory was found by BM25 (keyword match), keep it
    // regardless of vector similarity — the text matched directly.
    const inBm25 = bm25Ranked.some((r) => r.id === m.id);
    if (inBm25) return true;

    // For vector-only matches, check raw cosine similarity
    const emb = typeof mem.embedding === "string" ? JSON.parse(mem.embedding) : mem.embedding;
    const vecSim = cosineSimilarity(queryVector, emb);
    return vecSim >= MIN_VECTOR_SIMILARITY;
  });

  // === Decrypt content at rest ===
  const topResults = relevantResults.slice(0, limit);
  const decrypted = topResults.map((m) => ({
    ...m,
    content: decrypt(m.content, rawApiKey),
  }));

  // === Lazy backfill tsvectors for encrypted memories ===
  // Old memories may have empty/null tsvectors (pre-fix). When we decrypt them
  // during recall, update their tsvector so BM25 works on them going forward.
  const toBackfill = decrypted.filter((m) => {
    const mem = memoryMap.get(m.id);
    return mem && isEncrypted(mem.content) && (!mem.content_tsv || mem.content_tsv === "");
  });
  if (toBackfill.length > 0) {
    // Fire and forget — don't block the response
    Promise.all(
      toBackfill.map((m) =>
        sql`UPDATE memories SET content_tsv = to_tsvector('english', ${m.content}) WHERE id = ${m.id}`
      )
    ).catch((err) => console.warn("[recall] Lazy tsvector backfill failed:", err.message));
  }

  // Track usage
  await sql`
    INSERT INTO usage_events (api_key_id, event_type, agent_id, tokens)
    VALUES (${apiKeyId}, 'recall', ${agentId}, ${embeddingTokenEstimate(query)})
  `;

  return decrypted;
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
    RETURNING id, agent_id
  `;

  if (result.length > 0) {
    const agentId = (result[0] as any).agent_id || "unknown";
    // Track usage for billing and analytics
    await sql`
      INSERT INTO usage_events (api_key_id, event_type, agent_id, tokens)
      VALUES (${apiKeyId}, 'forget', ${agentId}, 0)
    `;
  }

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
