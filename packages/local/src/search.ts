import { getAll, ftsSearch, getCachedEntry, upsertCacheEntry } from "./db.js";
import { embed, embeddingFromBuffer } from "./embeddings.js";
import { parseAllFiles } from "./file-sources.js";
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

// --- Duplicate detection (Jaccard word overlap) ---

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const word of a) {
    if (b.has(word)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function tokenize(text: string): Set<string> {
  return new Set(
    text.toLowerCase().replace(/[^\w\s]/g, "").split(/\s+/).filter((w) => w.length > 2)
  );
}

/**
 * Detect near-duplicate entries across all results.
 * Uses Jaccard word overlap (threshold 0.8) for speed.
 */
function detectDuplicates(results: MemoryWithScore[]): void {
  if (results.length < 2) return;

  const tokenized = results.map((m) => ({ memory: m, words: tokenize(m.content) }));
  let groupCounter = 0;
  const assigned = new Set<number>();

  for (let i = 0; i < tokenized.length; i++) {
    if (assigned.has(i)) continue;
    const group: number[] = [i];

    for (let j = i + 1; j < tokenized.length; j++) {
      if (assigned.has(j)) continue;
      if (jaccardSimilarity(tokenized[i].words, tokenized[j].words) > 0.8) {
        group.push(j);
      }
    }

    if (group.length >= 2) {
      groupCounter++;
      const groupId = `dup-${groupCounter}`;
      for (const idx of group) {
        tokenized[idx].memory.duplicate_group = groupId;
        assigned.add(idx);
      }
    }
  }
}

// --- File source integration ---

interface FileCandidate {
  id: string;         // content_hash
  content: string;
  embedding: number[] | null;
  source: MemoryWithScore["source"];
  source_path: string;
  created_at: string; // first_seen from cache
}

/**
 * Load file-sourced memories, using cache for embeddings.
 * Only computes new embeddings for sections not yet cached.
 */
async function loadFileSources(): Promise<FileCandidate[]> {
  const { entries } = parseAllFiles();
  const candidates: FileCandidate[] = [];

  for (const entry of entries) {
    const cached = getCachedEntry(entry.content_hash);

    if (cached && cached.embedding) {
      // Cache hit — use stored embedding and first_seen
      candidates.push({
        id: entry.content_hash,
        content: entry.content,
        embedding: embeddingFromBuffer(cached.embedding),
        source: entry.source,
        source_path: entry.source_path,
        created_at: cached.first_seen,
      });
      // Update last_seen
      upsertCacheEntry({ ...entry, embedding: cached.embedding });
    } else {
      // Cache miss — compute embedding
      try {
        const vec = await embed(entry.content);
        const embBuf = Buffer.from(new Float32Array(vec).buffer);
        upsertCacheEntry({ ...entry, embedding: embBuf });
        candidates.push({
          id: entry.content_hash,
          content: entry.content,
          embedding: vec,
          source: entry.source,
          source_path: entry.source_path,
          created_at: new Date().toISOString(),
        });
      } catch (err: any) {
        // Embedding failed — include without vector search capability
        console.warn(`[file-sources] Embedding failed for ${entry.source_path}: ${err.message}`);
        upsertCacheEntry({ ...entry, embedding: null });
        candidates.push({
          id: entry.content_hash,
          content: entry.content,
          embedding: null,
          source: entry.source,
          source_path: entry.source_path,
          created_at: new Date().toISOString(),
        });
      }
    }
  }

  return candidates;
}

// --- Hybrid Search (enhanced with file sources) ---
//
//   Query ──embed──> Vector Search (DB memories + file sources)
//     │                    │
//     └──tsquery──> FTS5 Search (DB full-text)
//     │                    │
//     └──fuzzy───> Fuzzy Match (DB + file sources)
//                         │
//                    ┌────┴────┐
//                    │   RRF   │  Reciprocal Rank Fusion (k=60)
//                    └────┬────┘
//                         │
//                    Temporal Decay (85% relevance + 15% recency)
//                         │
//                    Quality Gate (min vector similarity 0.25)
//                         │
//                    Duplicate Detection (Jaccard > 0.8)
//                         │
//                    Return with source + freshness + dedup fields

export async function hybridSearch(
  agentId: string,
  query: string,
  options: { scope?: string; limit?: number; tags?: string[] } = {}
): Promise<MemoryWithScore[]> {
  const limit = options.limit || 10;
  const includeShared = options.scope !== "agent";

  // Get DB candidates
  const dbCandidates = getAll(agentId, { includeShared });

  // Get file source candidates
  let fileCandidates: FileCandidate[] = [];
  try {
    fileCandidates = await loadFileSources();
  } catch (err: any) {
    console.warn(`[search] File source loading failed: ${err.message}`);
  }

  if (dbCandidates.length === 0 && fileCandidates.length === 0) return [];

  // Filter DB by tags if specified
  let filteredDb = dbCandidates;
  if (options.tags && options.tags.length > 0) {
    filteredDb = dbCandidates.filter((m) => {
      const tags: string[] = JSON.parse(m.tags || "[]");
      return options.tags!.some((t) => tags.includes(t));
    });
  }

  // === Strategy 1: Vector search (DB + files) ===
  const queryVec = await embed(query);
  const vectorScored: { id: string; rank: number; score: number }[] = [];
  const memMap = new Map<string, { content: string; created_at: string; source: MemoryWithScore["source"]; source_path: string; tags: string[] }>();

  // DB memories
  for (const mem of filteredDb) {
    const tags: string[] = JSON.parse(mem.tags || "[]");
    memMap.set(mem.id, {
      content: mem.content,
      created_at: mem.created_at,
      source: "db",
      source_path: "~/.central-intelligence/memories.db",
      tags,
    });
    if (mem.embedding) {
      const memVec = embeddingFromBuffer(mem.embedding as Uint8Array);
      const score = cosineSimilarity(queryVec, memVec);
      vectorScored.push({ id: mem.id, rank: 0, score });
    }
  }

  // File source memories
  for (const fc of fileCandidates) {
    memMap.set(fc.id, {
      content: fc.content,
      created_at: fc.created_at,
      source: fc.source,
      source_path: fc.source_path,
      tags: [],
    });
    if (fc.embedding) {
      const score = cosineSimilarity(queryVec, fc.embedding);
      vectorScored.push({ id: fc.id, rank: 0, score });
    }
  }

  vectorScored.sort((a, b) => b.score - a.score);
  vectorScored.forEach((item, i) => (item.rank = i + 1));

  // === Strategy 2: FTS5 full-text search (DB only) ===
  const ftsRanked = ftsSearch(query, 50);

  // === Strategy 3: Fuzzy substring matching (DB + files) ===
  const allEntries = [
    ...filteredDb.map((m) => ({ id: m.id, content: m.content })),
    ...fileCandidates.map((fc) => ({ id: fc.id, content: fc.content })),
  ];
  const fuzzyScored = allEntries
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

  // === Apply temporal decay + build results ===
  const results: MemoryWithScore[] = [];
  for (const [id, rrfScore] of fusedScores.entries()) {
    const m = memMap.get(id);
    if (!m) continue;

    const decay = temporalDecay(m.created_at);
    const freshness = decay; // freshness_score = temporal decay value
    const finalScore = rrfScore * 0.85 + decay * rrfScore * 0.15;

    // Minimum relevance — check vector similarity for vector-only matches
    const vecItem = vectorScored.find((v) => v.id === id);
    const inFts = ftsRanked.some((f) => f.id === id);
    const inFuzzy = fuzzyScored.some((f) => f.id === id);
    if (!inFts && !inFuzzy && vecItem && vecItem.score < 0.25) continue;

    results.push({
      id,
      agent_id: "file",
      user_id: null,
      scope: m.source === "db" ? "agent" : "user",
      content: m.content,
      tags: m.tags,
      created_at: m.created_at,
      deleted_at: null,
      relevance_score: Math.round(finalScore * 10000) / 10000,
      source: m.source,
      source_path: m.source_path,
      freshness_score: Math.round(freshness * 10000) / 10000,
      duplicate_group: null,
    });
  }

  results.sort((a, b) => b.relevance_score - a.relevance_score);

  // === Duplicate detection ===
  detectDuplicates(results);

  return results.slice(0, limit);
}
