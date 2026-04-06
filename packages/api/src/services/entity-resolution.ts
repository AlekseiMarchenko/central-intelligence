/**
 * Entity resolution service — trigram + co-occurrence + temporal scoring.
 *
 * For each entity name extracted from facts:
 * 1. pg_trgm fuzzy match against existing entities table
 * 2. Score candidates: trigram similarity + co-occurrence with context entities + temporal proximity
 * 3. Merge if score >= threshold, else create new entity
 * 4. Link entities to facts via entity_facts junction
 * 5. Update entity co-occurrence counts
 *
 * Weights are configurable via env vars:
 *   ENTITY_TRIGRAM_WEIGHT (default 0.5)
 *   ENTITY_COOCCUR_WEIGHT (default 0.3)
 *   ENTITY_TEMPORAL_WEIGHT (default 0.2)
 *   ENTITY_MERGE_THRESHOLD (default 0.6)
 */

import { sql } from "../db/connection.js";
import { temporalDecay } from "./memories.js";

// --- Config from env vars with defaults ---

const TRIGRAM_WEIGHT = parseFloat(process.env.ENTITY_TRIGRAM_WEIGHT || "0.5");
const COOCCUR_WEIGHT = parseFloat(process.env.ENTITY_COOCCUR_WEIGHT || "0.3");
const TEMPORAL_WEIGHT = parseFloat(process.env.ENTITY_TEMPORAL_WEIGHT || "0.2");
const MERGE_THRESHOLD = parseFloat(process.env.ENTITY_MERGE_THRESHOLD || "0.6");

// --- Types ---

export interface EntityCandidate {
  id: string;
  canonical: string;
  entity_type: string;
  mention_count: number;
  last_seen: string;
  trigram_similarity: number;
}

export interface EntityWeights {
  trigram: number;
  cooccurrence: number;
  temporal: number;
}

// --- Pure scoring function (exported for unit testing) ---

/**
 * Score a candidate entity for merge decision.
 *
 * @param candidate - The existing entity to score against
 * @param contextEntityIds - IDs of entities already resolved in this batch
 * @param cooccurrenceCounts - Map of candidate entity ID → co-occurrence count with context entities
 * @param maxCooccurrence - Max co-occurrence count across all candidates (for normalization)
 * @param now - Current timestamp
 * @param weights - Scoring weights
 * @returns Total score (0-1 range)
 */
export function scoreCandidate(
  candidate: EntityCandidate,
  contextEntityIds: string[],
  cooccurrenceCounts: Map<string, number>,
  maxCooccurrence: number,
  now: Date,
  weights: EntityWeights = { trigram: TRIGRAM_WEIGHT, cooccurrence: COOCCUR_WEIGHT, temporal: TEMPORAL_WEIGHT },
): number {
  // Trigram component: similarity * weight (0 to weights.trigram)
  const trigramScore = candidate.trigram_similarity * weights.trigram;

  // Co-occurrence component: normalized count * weight (0 to weights.cooccurrence)
  let cooccurrenceScore = 0;
  if (maxCooccurrence > 0 && contextEntityIds.length > 0) {
    const count = cooccurrenceCounts.get(candidate.id) || 0;
    cooccurrenceScore = (count / maxCooccurrence) * weights.cooccurrence;
  }

  // Temporal component: recency decay * weight (0 to weights.temporal)
  // Uses 180-day half-life (entities seen 6 months ago get half score)
  const temporalScore = temporalDecay(candidate.last_seen, 180) * weights.temporal;

  return trigramScore + cooccurrenceScore + temporalScore;
}

// --- DB functions ---

/**
 * Resolve a batch of entity names to entity IDs.
 * Creates new entities or merges with existing ones based on scoring.
 *
 * @returns Map of entity name → entity ID
 */
export async function resolveEntities(
  apiKeyId: string,
  agentId: string,
  entityNames: Array<{ name: string; type?: string }>,
): Promise<Map<string, string>> {
  const resolved = new Map<string, string>();
  if (entityNames.length === 0) return resolved;

  // Track already-resolved entity IDs for co-occurrence scoring
  const contextEntityIds: string[] = [];

  for (const { name, type } of entityNames) {
    const canonical = name.toLowerCase().trim();
    if (!canonical || resolved.has(name)) continue;

    try {
      const entityId = await resolveOneEntity(
        apiKeyId,
        agentId,
        name,
        canonical,
        type || "unknown",
        contextEntityIds,
      );
      resolved.set(name, entityId);
      contextEntityIds.push(entityId);
    } catch (err: any) {
      console.warn(`[entity-resolution] Failed to resolve "${name}":`, err.message);
    }
  }

  return resolved;
}

async function resolveOneEntity(
  apiKeyId: string,
  agentId: string,
  name: string,
  canonical: string,
  entityType: string,
  contextEntityIds: string[],
): Promise<string> {
  // Step 1: Find candidates via pg_trgm fuzzy matching
  const candidates = await sql`
    SELECT id, canonical, entity_type, mention_count,
           last_seen::text as last_seen,
           similarity(canonical, ${canonical}) as trigram_similarity
    FROM entities
    WHERE api_key_id = ${apiKeyId}
      AND agent_id = ${agentId}
      AND similarity(canonical, ${canonical}) > 0.15
    ORDER BY similarity(canonical, ${canonical}) DESC
    LIMIT 10
  ` as unknown as EntityCandidate[];

  if (candidates.length === 0) {
    return createEntity(apiKeyId, agentId, name, canonical, entityType);
  }

  // Step 2: Load co-occurrence data for scoring
  let cooccurrenceCounts = new Map<string, number>();
  let maxCooccurrence = 0;

  if (contextEntityIds.length > 0) {
    const candidateIds = candidates.map((c) => c.id);
    const cooccRows = await sql`
      SELECT
        CASE WHEN entity_a = ANY(${candidateIds}) THEN entity_a ELSE entity_b END as candidate_id,
        SUM(count) as total_count
      FROM entity_cooccurrences
      WHERE (entity_a = ANY(${candidateIds}) AND entity_b = ANY(${contextEntityIds}))
         OR (entity_b = ANY(${candidateIds}) AND entity_a = ANY(${contextEntityIds}))
      GROUP BY candidate_id
    `;
    for (const row of cooccRows) {
      const count = Number(row.total_count);
      cooccurrenceCounts.set(row.candidate_id, count);
      if (count > maxCooccurrence) maxCooccurrence = count;
    }
  }

  // Step 3: Score candidates
  const weights: EntityWeights = {
    trigram: TRIGRAM_WEIGHT,
    cooccurrence: COOCCUR_WEIGHT,
    temporal: TEMPORAL_WEIGHT,
  };

  let bestCandidate: EntityCandidate | null = null;
  let bestScore = 0;

  for (const candidate of candidates) {
    const score = scoreCandidate(
      candidate,
      contextEntityIds,
      cooccurrenceCounts,
      maxCooccurrence,
      new Date(),
      weights,
    );
    if (score > bestScore) {
      bestScore = score;
      bestCandidate = candidate;
    }
  }

  // Step 4: Merge or create
  if (bestCandidate && bestScore >= MERGE_THRESHOLD) {
    console.log(
      `[entity-resolution] Merge "${name}" → "${bestCandidate.canonical}" ` +
        `(score=${bestScore.toFixed(3)}, trigram=${bestCandidate.trigram_similarity.toFixed(3)}, ` +
        `cooccur=${(cooccurrenceCounts.get(bestCandidate.id) || 0)}, threshold=${MERGE_THRESHOLD})`,
    );
    await sql`
      UPDATE entities
      SET mention_count = mention_count + 1, last_seen = now()
      WHERE id = ${bestCandidate.id}
    `;
    return bestCandidate.id;
  }

  return createEntity(apiKeyId, agentId, name, canonical, entityType);
}

async function createEntity(
  apiKeyId: string,
  agentId: string,
  name: string,
  canonical: string,
  entityType: string,
): Promise<string> {
  // ON CONFLICT handles race conditions (concurrent creates for same entity)
  const [entity] = await sql`
    INSERT INTO entities (api_key_id, agent_id, name, canonical, entity_type)
    VALUES (${apiKeyId}, ${agentId}, ${name}, ${canonical}, ${entityType})
    ON CONFLICT (api_key_id, agent_id, canonical) DO UPDATE
    SET mention_count = entities.mention_count + 1, last_seen = now()
    RETURNING id
  `;
  return entity.id;
}

/**
 * Update co-occurrence counts for all pairs of entity IDs.
 * Uses ordered pairs (a < b) to avoid duplicates.
 */
export async function updateCooccurrences(entityIds: string[]): Promise<void> {
  if (entityIds.length < 2) return;

  // Build all unique ordered pairs
  const pairs: Array<{ a: string; b: string }> = [];
  for (let i = 0; i < entityIds.length; i++) {
    for (let j = i + 1; j < entityIds.length; j++) {
      const [a, b] = entityIds[i] < entityIds[j]
        ? [entityIds[i], entityIds[j]]
        : [entityIds[j], entityIds[i]];
      pairs.push({ a, b });
    }
  }

  // Batch upsert co-occurrences
  for (const { a, b } of pairs) {
    try {
      await sql`
        INSERT INTO entity_cooccurrences (entity_a, entity_b, count)
        VALUES (${a}, ${b}, 1)
        ON CONFLICT (entity_a, entity_b) DO UPDATE
        SET count = entity_cooccurrences.count + 1
      `;
    } catch (err: any) {
      console.warn(`[entity-resolution] Co-occurrence update failed:`, err.message);
    }
  }
}

/**
 * Link entities to fact_units via the entity_facts junction table.
 */
export async function linkEntitiesToFacts(
  pairs: Array<{ entityId: string; factId: string }>,
): Promise<void> {
  for (const { entityId, factId } of pairs) {
    try {
      await sql`
        INSERT INTO entity_facts (entity_id, fact_id)
        VALUES (${entityId}, ${factId})
        ON CONFLICT DO NOTHING
      `;
    } catch (err: any) {
      console.warn(`[entity-resolution] Entity-fact link failed:`, err.message);
    }
  }
}
