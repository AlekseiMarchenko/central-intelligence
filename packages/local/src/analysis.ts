/**
 * Freshness and duplicate analysis for CI Local Pro.
 * Uses the same algorithms as CI Local MCP server (exponential decay, cosine similarity).
 */

// --- Freshness ---

export function computeFreshness(createdAt: string, halfLifeDays: number = 90): number {
  const ageMs = Date.now() - new Date(createdAt).getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  return Math.pow(0.5, ageDays / halfLifeDays);
}

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

// --- Duplicate Detection ---

interface MemoryForDedup {
  id: string;
  content: string;
  source: string;
  freshness_score: number;
  duplicate_group: string | null;
  [key: string]: unknown;
}

/**
 * Detect near-duplicate memories using simple text similarity.
 * Uses normalized word overlap (Jaccard-like) instead of embeddings
 * to avoid requiring the embedding model for audit operations.
 *
 * Threshold: 0.8 word overlap = likely duplicate.
 * This is faster than embedding-based dedup (~1ms vs ~200ms per comparison)
 * and good enough for audit purposes.
 */
export function detectDuplicates<T extends MemoryForDedup>(memories: T[]): T[] {
  if (memories.length < 2) return memories;

  // Tokenize each memory
  const tokenized = memories.map((m) => ({
    memory: m,
    words: new Set(
      m.content
        .toLowerCase()
        .replace(/[^\w\s]/g, "")
        .split(/\s+/)
        .filter((w) => w.length > 2)
    ),
  }));

  let groupCounter = 0;
  const assigned = new Set<number>();

  for (let i = 0; i < tokenized.length; i++) {
    if (assigned.has(i)) continue;

    const group: number[] = [i];

    for (let j = i + 1; j < tokenized.length; j++) {
      if (assigned.has(j)) continue;

      const overlap = jaccardSimilarity(tokenized[i].words, tokenized[j].words);
      if (overlap > 0.8) {
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

  return memories;
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const word of a) {
    if (b.has(word)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
