import { getAll, ftsSearch } from "./db.js";
import { embed, embeddingFromBuffer } from "./embeddings.js";
import type { MemoryRow, MemoryWithScore } from "./types.js";

// --- Cosine Similarity ---
function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// --- Temporal Decay ---
function temporalDecay(createdAt: string, halfLifeDays: number = 90): number {
  const ageMs = Date.now() - new Date(createdAt).getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  return Math.pow(0.5, ageDays / halfLifeDays);
}

// --- Reciprocal Rank Fusion ---
function rrf(rankedLists: { id: string; rank: number }[][], k: number = 60): Map<string, number> {
  const scores = new Map<string, number>();
  for (const list of rankedLists) {
    for (const item of list) {
      scores.set(item.id, (scores.get(item.id) || 0) + 1 / (k + item.rank));
    }
  }
  return scores;
}

// --- Fuzzy substring matching ---
function fuzzyMatch(query: string, content: string): number {
  const q = query.toLowerCase();
  const c = content.toLowerCase();
  const words = q.split(/\s+/).filter(w => w.length > 2);
  if (words.length === 0) return 0;
  let matches = 0;
  for (const word of words) {
    if (c.includes(word)) matches++;
  }
  return matches / words.length;
}

// --- Hybrid Search ---
export async function hybridSearch(
  agentId: string,
  query: string,
  options: { scope?: string; limit?: number; tags?: string[] } = {}
): Promise<MemoryWithScore[]> {
  const limit = options.limit || 10;
  const includeShared = options.scope !== "agent";

  // Get all candidate memories
  const candidates = getAll(agentId, { includeShared });
  if (candidates.length === 0) return [];

  // Filter by tags if specified
  let filtered = candidates;
  if (options.tags && options.tags.length > 0) {
    filtered = candidates.filter((m) => {
      const tags: string[] = JSON.parse(m.tags || "[]");
      return options.tags!.some((t) => tags.includes(t));
    });
  }

  // === Strategy 1: Vector search ===
  const queryVec = await embed(query);
  const vectorScored: { id: string; rank: number; score: number }[] = [];
  const memMap = new Map<string, MemoryRow>();

  for (const mem of filtered) {
    memMap.set(mem.id, mem);
    if (mem.embedding) {
      const memVec = embeddingFromBuffer(mem.embedding as Buffer);
      const score = cosineSimilarity(queryVec, memVec);
      vectorScored.push({ id: mem.id, rank: 0, score });
    }
  }

  vectorScored.sort((a, b) => b.score - a.score);
  vectorScored.forEach((item, i) => (item.rank = i + 1));

  // === Strategy 2: FTS5 full-text search ===
  const ftsRanked = ftsSearch(query, 50);

  // === Strategy 3: Fuzzy substring matching ===
  const fuzzyScored = filtered
    .map((m) => ({ id: m.id, score: fuzzyMatch(query, m.content) }))
    .filter((m) => m.score > 0.2)
    .sort((a, b) => b.score - a.score)
    .map((m, i) => ({ id: m.id, rank: i + 1 }));

  // === Reciprocal Rank Fusion ===
  const rankedLists = [
    vectorScored.map((v) => ({ id: v.id, rank: v.rank })),
    ftsRanked,
    fuzzyScored,
  ].filter((l) => l.length > 0);

  let fusedScores: Map<string, number>;
  if (rankedLists.length > 1) {
    fusedScores = rrf(rankedLists);
  } else if (vectorScored.length > 0) {
    fusedScores = new Map(vectorScored.map((v) => [v.id, v.score]));
  } else {
    return [];
  }

  // === Apply temporal decay ===
  const results: MemoryWithScore[] = [];
  for (const [id, rrfScore] of fusedScores.entries()) {
    const m = memMap.get(id);
    if (!m) continue;

    const decay = temporalDecay(m.created_at);
    const finalScore = rrfScore * 0.85 + decay * rrfScore * 0.15;

    // Minimum relevance — check vector similarity
    const vecItem = vectorScored.find((v) => v.id === id);
    const inFts = ftsRanked.some((f) => f.id === id);
    const inFuzzy = fuzzyScored.some((f) => f.id === id);
    if (!inFts && !inFuzzy && vecItem && vecItem.score < 0.25) continue;

    const tags: string[] = JSON.parse(m.tags || "[]");
    results.push({
      id: m.id,
      agent_id: m.agent_id,
      user_id: m.user_id,
      scope: m.scope as "agent" | "user" | "org",
      content: m.content,
      tags,
      created_at: m.created_at,
      deleted_at: m.deleted_at,
      relevance_score: Math.round(finalScore * 10000) / 10000,
    });
  }

  results.sort((a, b) => b.relevance_score - a.relevance_score);
  return results.slice(0, limit);
}
