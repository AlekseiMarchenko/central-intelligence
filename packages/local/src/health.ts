import type { FileSourceEntry } from "./file-sources.js";

export interface HealthResult {
  score: number; // 0-10
  issues: string[];
  stats: {
    total_memories: number;
    db_memories: number;
    file_entries: number;
    stale_count: number;
    duplicate_groups: number;
    sources_detected: number;
  };
}

interface MemoryForHealth {
  freshness_score: number;
  duplicate_group: string | null;
  source: string;
}

/**
 * Compute memory health score (0-10).
 *
 * Heuristic:
 * - Start at 10
 * - -1 per 10 stale entries (freshness < 0.3)
 * - -2 per duplicate group with 3+ near-duplicates
 * - -1 if total > 500 (bloat)
 * - -1 if no file sources detected
 * - min 0
 */
export function computeHealth(
  memories: MemoryForHealth[],
  fileSources: FileSourceEntry[]
): HealthResult {
  let score = 10;
  const issues: string[] = [];

  const dbMemories = memories.filter((m) => m.source === "db");
  const staleCount = memories.filter((m) => m.freshness_score < 0.3).length;
  const total = memories.length + fileSources.length;

  // Count unique duplicate groups with 3+ members
  const groupCounts = new Map<string, number>();
  for (const m of memories) {
    if (m.duplicate_group) {
      groupCounts.set(m.duplicate_group, (groupCounts.get(m.duplicate_group) || 0) + 1);
    }
  }
  const largeGroups = [...groupCounts.entries()].filter(([, count]) => count >= 3);

  // Stale penalty
  const stalePenalty = Math.floor(staleCount / 10);
  if (stalePenalty > 0) {
    score -= stalePenalty;
    issues.push(`${staleCount} stale memories (freshness < 0.3). Consider cleaning up with 'ci audit --clean'.`);
  }

  // Duplicate penalty
  if (largeGroups.length > 0) {
    score -= largeGroups.length * 2;
    issues.push(
      `${largeGroups.length} duplicate group(s) with 3+ near-copies. Run 'ci audit --dedup' to review.`
    );
  }

  // Bloat penalty
  if (total > 500) {
    score -= 1;
    issues.push(`${total} total memories. Consider archiving old entries.`);
  }

  // No file sources penalty
  const uniqueSources = new Set(fileSources.map((f) => f.source));
  if (uniqueSources.size === 0) {
    score -= 1;
    issues.push(
      "No AI tool config files detected. Add a CLAUDE.md or .cursor/rules to get cross-tool memory."
    );
  }

  score = Math.max(0, score);

  if (issues.length === 0) {
    issues.push("Memory is healthy. No issues detected.");
  }

  return {
    score,
    issues,
    stats: {
      total_memories: total,
      db_memories: dbMemories.length,
      file_entries: fileSources.length,
      stale_count: staleCount,
      duplicate_groups: largeGroups.length,
      sources_detected: uniqueSources.size,
    },
  };
}
