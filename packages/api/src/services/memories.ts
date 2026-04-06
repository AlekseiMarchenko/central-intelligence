import { sql } from "../db/connection.js";
import { embed, embeddingTokenEstimate } from "./embeddings.js";
import { encrypt, decrypt, isEncrypted } from "./encryption.js";
import { rerank } from "./rerank.js";
import { isPgvectorAvailable } from "../db/migrate-pgvector.js";
import { parseDates } from "./date-parser.js";
import { decomposeQuery } from "./query-decompose.js";
import { extractFacts } from "./fact-extraction.js";
import {
  resolveEntities,
  updateCooccurrences,
  linkEntitiesToFacts,
} from "./entity-resolution.js";
import { consolidateObservations } from "./observations.js";

// Cache pgvector availability check (set on first recall)
let _pgvectorAvailable: boolean | null = null;

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
  eventDateFrom?: string;
  eventDateTo?: string;
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
  dateFrom?: string;
  dateTo?: string;
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

// --- pgvector ANN search ---

async function pgvectorSearch(
  apiKeyId: string,
  agentId: string,
  queryVector: number[],
  limit: number = 200,
  dateFrom?: string,
  dateTo?: string,
  includeShared: boolean = false,
): Promise<{ id: string; rank: number; score: number }[]> {
  const vecStr = `[${queryVector.join(",")}]`;

  // Date filtering: use event_date columns (content-parsed dates) when available,
  // with NULL event_dates always passing through (dateless memories like preferences).
  // When no date filter is provided, all memories are searched.
  const hasDateFilter = dateFrom || dateTo;
  const effectiveDateFrom = dateFrom || "1970-01-01T00:00:00Z";
  const effectiveDateTo = dateTo || "2099-12-31T23:59:59Z";

  // Agent's own memories
  const agentResults = hasDateFilter
    ? await sql`
        SELECT id, 1 - (embedding_vec <=> ${vecStr}::vector) as similarity
        FROM memories
        WHERE api_key_id = ${apiKeyId}
          AND agent_id = ${agentId}
          AND deleted_at IS NULL
          AND embedding_vec IS NOT NULL
          AND (
            event_date_from IS NULL
            OR (event_date_to >= ${effectiveDateFrom}::timestamptz
                AND event_date_from <= ${effectiveDateTo}::timestamptz)
          )
        ORDER BY embedding_vec <=> ${vecStr}::vector
        LIMIT ${limit}
      `
    : await sql`
        SELECT id, 1 - (embedding_vec <=> ${vecStr}::vector) as similarity
        FROM memories
        WHERE api_key_id = ${apiKeyId}
          AND agent_id = ${agentId}
          AND deleted_at IS NULL
          AND embedding_vec IS NOT NULL
        ORDER BY embedding_vec <=> ${vecStr}::vector
        LIMIT ${limit}
      `;

  let allResults = [...(agentResults as any[])];

  // Shared memories (user/org scope)
  if (includeShared) {
    const sharedResults = hasDateFilter
      ? await sql`
          SELECT id, 1 - (embedding_vec <=> ${vecStr}::vector) as similarity
          FROM memories
          WHERE api_key_id = ${apiKeyId}
            AND scope IN ('user', 'org')
            AND agent_id != ${agentId}
            AND deleted_at IS NULL
            AND embedding_vec IS NOT NULL
            AND (
              event_date_from IS NULL
              OR (event_date_to >= ${effectiveDateFrom}::timestamptz
                  AND event_date_from <= ${effectiveDateTo}::timestamptz)
            )
          ORDER BY embedding_vec <=> ${vecStr}::vector
          LIMIT ${Math.floor(limit / 2)}
        `
      : await sql`
          SELECT id, 1 - (embedding_vec <=> ${vecStr}::vector) as similarity
          FROM memories
          WHERE api_key_id = ${apiKeyId}
            AND scope IN ('user', 'org')
            AND agent_id != ${agentId}
            AND deleted_at IS NULL
            AND embedding_vec IS NOT NULL
          ORDER BY embedding_vec <=> ${vecStr}::vector
          LIMIT ${Math.floor(limit / 2)}
        `;
    allResults = [...allResults, ...(sharedResults as any[])];
  }

  return allResults.map((r: any, i: number) => ({
    id: r.id,
    rank: i + 1,
    score: parseFloat(r.similarity),
  }));
}

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

  // Parse dates from plaintext BEFORE encryption for temporal filtering.
  // Explicit dates from caller take priority (e.g., benchmark harness knows the event date).
  const parsed = parseDates(content);
  const eventFrom = params.eventDateFrom || parsed.eventDateFrom;
  const eventTo = params.eventDateTo || parsed.eventDateTo;

  // Encrypt content at rest
  const encryptedContent = encrypt(content, rawApiKey);

  // Generate tsvector from plaintext BEFORE encryption for BM25 search.
  // This leaks word stems (not full content) — accepted tradeoff for search functionality.
  const vecStr = `[${vector.join(",")}]`;
  const [memory] = await sql`
    INSERT INTO memories (api_key_id, agent_id, user_id, org_id, scope, content, tags, embedding, embedding_vec, content_tsv, event_date_from, event_date_to)
    VALUES (
      ${apiKeyId}, ${agentId}, ${userId || null}, ${orgId || null}, ${scope},
      ${encryptedContent}, ${tags}, ${JSON.stringify(vector)}::jsonb,
      ${vecStr}::vector,
      to_tsvector('english', ${content}),
      ${eventFrom || null}::timestamptz,
      ${eventTo || null}::timestamptz
    )
    RETURNING id, agent_id, user_id, org_id, scope, content, tags, created_at, updated_at
  `;

  // Return decrypted content to the caller
  const result = memory as unknown as Memory;
  result.content = content;

  // Create a fallback fact_unit synchronously (~1ms INSERT).
  // This ensures the memory is searchable in fact_units immediately,
  // even before structured extraction completes.
  const fallbackId = await createFallbackFact(
    result.id, apiKeyId, agentId, encryptedContent, vecStr, content, eventFrom, eventTo,
  );

  // Queue structured fact extraction (fire-and-forget, max N concurrent).
  // Replaces the old enrichMemoryAsync() with full structured fact decomposition.
  queueFactExtraction({
    memoryId: result.id,
    apiKeyId,
    agentId,
    rawApiKey,
    plaintext: content,
    fallbackFactId: fallbackId,
    eventFrom: eventFrom || null,
    eventTo: eventTo || null,
  });

  // Track usage
  await sql`
    INSERT INTO usage_events (api_key_id, event_type, agent_id, tokens)
    VALUES (${apiKeyId}, 'remember', ${agentId}, ${embeddingTokenEstimate(content)})
  `;

  return result;
}

// --- Fact extraction queue (max N concurrent, fire-and-forget) ---

const MAX_EXTRACTION_CONCURRENCY = parseInt(process.env.MAX_EXTRACTION_CONCURRENCY || "3");
let _activeExtractions = 0;
const _extractionQueue: Array<() => Promise<void>> = [];

interface ExtractionParams {
  memoryId: string;
  apiKeyId: string;
  agentId: string;
  rawApiKey: string;
  plaintext: string;
  fallbackFactId: string;
  eventFrom: string | null;
  eventTo: string | null;
}

function queueFactExtraction(params: ExtractionParams): void {
  const task = () => processExtraction(params);
  if (_activeExtractions < MAX_EXTRACTION_CONCURRENCY) {
    _activeExtractions++;
    task().finally(() => { _activeExtractions--; drainExtractionQueue(); });
  } else {
    _extractionQueue.push(task);
  }
}

function drainExtractionQueue(): void {
  while (_extractionQueue.length > 0 && _activeExtractions < MAX_EXTRACTION_CONCURRENCY) {
    _activeExtractions++;
    const next = _extractionQueue.shift()!;
    next().finally(() => { _activeExtractions--; drainExtractionQueue(); });
  }
}

/**
 * Insert a raw fallback fact_unit — same embedding and tsvector as the parent memory.
 * Ensures the memory is searchable in fact_units from millisecond one.
 * Replaced with structured facts when extraction succeeds.
 */
async function createFallbackFact(
  memoryId: string,
  apiKeyId: string,
  agentId: string,
  encryptedContent: string,
  vecStr: string,
  plaintext: string,
  eventFrom: string | null | undefined,
  eventTo: string | null | undefined,
): Promise<string> {
  const [fallback] = await sql`
    INSERT INTO fact_units (
      memory_id, api_key_id, agent_id, fact_text, fact_type,
      embedding_vec, search_vector, event_date_from, event_date_to, is_fallback
    )
    VALUES (
      ${memoryId}, ${apiKeyId}, ${agentId}, ${encryptedContent}, 'world',
      ${vecStr}::vector, to_tsvector('english', ${plaintext}),
      ${eventFrom || null}::timestamptz, ${eventTo || null}::timestamptz, true
    )
    RETURNING id
  `;
  return fallback.id;
}

/**
 * Full fact extraction orchestrator. Called from the extraction queue.
 *
 * 1. Extract structured facts via GPT-4o-mini
 * 2. Insert fact_units with individual embeddings
 * 3. Resolve entities (create or merge)
 * 4. Link entities to facts, update co-occurrences
 * 5. Build temporal + causal links
 * 6. Delete fallback fact_unit
 * 7. Populate legacy entities/preferences JSONB (backward compat)
 * 8. Mark extraction_status = 'complete'
 *
 * Retries up to 3 times with exponential backoff on failure.
 */
async function processExtraction(params: ExtractionParams): Promise<void> {
  const { memoryId, apiKeyId, agentId, rawApiKey, plaintext, fallbackFactId, eventFrom, eventTo } = params;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await sql`UPDATE memories SET extraction_status = 'processing' WHERE id = ${memoryId}`;

      // Step 1: Extract structured facts
      const extraction = await extractFacts(plaintext);
      if (extraction.facts.length === 0 && extraction.preferences.length === 0) {
        // Nothing to extract — keep the fallback, mark complete
        await sql`UPDATE memories SET extraction_status = 'complete' WHERE id = ${memoryId}`;
        return;
      }

      // Step 2: Insert fact_units with individual embeddings
      const factIds: string[] = [];
      const allEntityNames: Array<{ name: string; type?: string }> = [];
      const factEntityMap: Array<{ factId: string; entityNames: string[] }> = [];

      for (const fact of extraction.facts) {
        const factEmbedding = await embed(fact.what);
        const encryptedFact = encrypt(fact.what, rawApiKey);
        const factVecStr = `[${factEmbedding.join(",")}]`;
        const factEventFrom = fact.when?.start || eventFrom;
        const factEventTo = fact.when?.end || eventTo;
        const entityNames = fact.entities.length > 0 ? JSON.stringify(fact.entities) : null;

        const [inserted] = await sql`
          INSERT INTO fact_units (
            memory_id, api_key_id, agent_id, fact_text, fact_type,
            embedding_vec, search_vector, event_date_from, event_date_to, entities
          )
          VALUES (
            ${memoryId}, ${apiKeyId}, ${agentId}, ${encryptedFact}, ${fact.fact_type},
            ${factVecStr}::vector, to_tsvector('english', ${fact.what}),
            ${factEventFrom || null}::timestamptz, ${factEventTo || null}::timestamptz,
            ${entityNames}::jsonb
          )
          RETURNING id
        `;
        factIds.push(inserted.id);

        // Collect entities for resolution
        for (const entityName of fact.entities) {
          if (!allEntityNames.some((e) => e.name.toLowerCase() === entityName.toLowerCase())) {
            allEntityNames.push({ name: entityName });
          }
        }
        // Track which entities belong to which fact
        factEntityMap.push({ factId: inserted.id, entityNames: fact.entities });

        // Extract entity types from who[] field
        for (const person of fact.who) {
          if (!allEntityNames.some((e) => e.name.toLowerCase() === person.name.toLowerCase())) {
            allEntityNames.push({ name: person.name, type: "person" });
          }
        }
      }

      // Step 3: Resolve entities (create or merge with existing)
      const entityNameToId = await resolveEntities(apiKeyId, agentId, allEntityNames);

      // Step 4: Link entities to facts
      const linkPairs: Array<{ entityId: string; factId: string }> = [];
      for (const { factId, entityNames: names } of factEntityMap) {
        for (const name of names) {
          const entityId = entityNameToId.get(name);
          if (entityId) {
            linkPairs.push({ entityId, factId });
          }
        }
      }
      await linkEntitiesToFacts(linkPairs);

      // Step 5: Update co-occurrences
      const allEntityIds = [...new Set([...entityNameToId.values()])];
      await updateCooccurrences(allEntityIds);

      // Step 6: Build causal links from extraction
      for (const fact of extraction.facts) {
        if (fact.causal_relations.length === 0) continue;
        const factIdx = extraction.facts.indexOf(fact);
        if (factIdx < 0 || !factIds[factIdx]) continue;
        const sourceFactId = factIds[factIdx];

        // Causal relations reference effects — find matching facts
        for (const effect of fact.causal_relations) {
          for (let j = 0; j < extraction.facts.length; j++) {
            if (j === factIdx) continue;
            // Simple heuristic: if effect text overlaps with another fact's what
            if (extraction.facts[j].what.toLowerCase().includes(effect.toLowerCase().substring(0, 20))) {
              try {
                await sql`
                  INSERT INTO fact_links (from_fact_id, to_fact_id, link_type, weight)
                  VALUES (${sourceFactId}, ${factIds[j]}, 'causal', 1.0)
                  ON CONFLICT DO NOTHING
                `;
              } catch {}
            }
          }
        }
      }

      // Step 7: Build temporal links (facts with dates within 24 hours)
      await buildTemporalLinks(factIds);

      // Step 8: Delete the fallback fact_unit
      await sql`DELETE FROM fact_units WHERE id = ${fallbackFactId}`;

      // Step 9: Populate legacy JSONB columns for backward compat
      const allEntities = [...entityNameToId.keys()];
      const preferences = extraction.preferences;
      if (allEntities.length > 0 || preferences.length > 0) {
        const enrichedText = [...allEntities, ...preferences].join(" ");
        await sql`
          UPDATE memories SET
            entities = ${JSON.stringify(allEntities)}::jsonb,
            preferences = ${JSON.stringify(preferences)}::jsonb,
            enriched_at = now(),
            content_tsv = content_tsv || to_tsvector('english', ${enrichedText})
          WHERE id = ${memoryId}
        `;
      }

      // Step 10: Mark complete
      await sql`UPDATE memories SET extraction_status = 'complete' WHERE id = ${memoryId}`;

      // Step 11: Trigger observation consolidation (fire-and-forget)
      // Checks if any entity now has enough facts for an auto-generated observation.
      consolidateObservations(apiKeyId, agentId, rawApiKey, memoryId).catch((err) => {
        console.warn(`[observations] Consolidation failed for memory ${memoryId}:`, err.message);
      });

      return;

    } catch (err: any) {
      const retries = attempt + 1;
      console.warn(`[fact-extraction] Attempt ${retries}/3 failed for memory ${memoryId}:`, err.message);
      await sql`UPDATE memories SET extraction_retries = ${retries} WHERE id = ${memoryId}`;

      if (retries < 3) {
        // Exponential backoff: 1s, 2s, 4s
        await new Promise((resolve) => setTimeout(resolve, 1000 * Math.pow(2, attempt)));
      } else {
        await sql`UPDATE memories SET extraction_status = 'failed' WHERE id = ${memoryId}`;
        console.warn(`[fact-extraction] Giving up on memory ${memoryId} after 3 attempts`);
      }
    }
  }
}

/**
 * Build temporal links between facts that have event dates within 24 hours.
 * Weight decays linearly: 1.0 at 0 hours, 0.0 at 24 hours.
 * Max 20 links per fact to avoid combinatorial explosion.
 */
async function buildTemporalLinks(factIds: string[]): Promise<void> {
  if (factIds.length < 2) return;

  // Fetch event dates for all facts
  const rows = await sql`
    SELECT id, event_date_from FROM fact_units
    WHERE id = ANY(${factIds}) AND event_date_from IS NOT NULL
  `;

  if (rows.length < 2) return;

  const factsWithDates = rows.map((r: any) => ({
    id: r.id,
    date: new Date(r.event_date_from).getTime(),
  }));

  // Find all pairs within 24 hours
  const links: Array<{ from: string; to: string; weight: number }> = [];
  for (let i = 0; i < factsWithDates.length; i++) {
    let linksForFact = 0;
    for (let j = i + 1; j < factsWithDates.length; j++) {
      if (linksForFact >= 20) break;
      const hoursDiff = Math.abs(factsWithDates[i].date - factsWithDates[j].date) / (1000 * 60 * 60);
      if (hoursDiff <= 24) {
        const weight = 1.0 - hoursDiff / 24;
        links.push({ from: factsWithDates[i].id, to: factsWithDates[j].id, weight });
        linksForFact++;
      }
    }
  }

  for (const { from, to, weight } of links) {
    try {
      await sql`
        INSERT INTO fact_links (from_fact_id, to_fact_id, link_type, weight)
        VALUES (${from}, ${to}, 'temporal', ${weight})
        ON CONFLICT DO NOTHING
      `;
    } catch {}
  }
}

// --- Fact-based search strategies (Sprint 2: 4-way parallel retrieval) ---
//
//   Query ──embed──> Fact Vector Search ──┐
//     │                                   │
//     ├──tsquery──> Fact BM25 Search ─────┤
//     │                                   │
//     ├──pg_trgm──> Graph Search ─────────┤    RRF ──> Temporal Decay ──> Rerank ──> Facade
//     │             (dual-seed CTE)       │
//     └──dates───> Temporal Search ───────┘

// Cache fact_units availability (set on first recall)
let _factUnitsAvailable: boolean | null = null;

async function checkFactUnitsAvailable(): Promise<boolean> {
  try {
    const result = await sql`
      SELECT EXISTS (
        SELECT 1 FROM fact_units WHERE embedding_vec IS NOT NULL LIMIT 1
      ) as has_data
    `;
    return result[0].has_data === true;
  } catch {
    return false;
  }
}

/** Vector search against fact_units table */
async function factVectorSearch(
  apiKeyId: string,
  agentId: string,
  queryVector: number[],
  limit: number = 200,
): Promise<{ id: string; rank: number; score: number }[]> {
  const vecStr = `[${queryVector.join(",")}]`;
  const results = await sql`
    SELECT id, 1 - (embedding_vec <=> ${vecStr}::vector) as similarity
    FROM fact_units
    WHERE api_key_id = ${apiKeyId}
      AND agent_id = ${agentId}
      AND embedding_vec IS NOT NULL
    ORDER BY embedding_vec <=> ${vecStr}::vector
    LIMIT ${limit}
  `;
  return (results as any[]).map((r: any, i: number) => ({
    id: r.id,
    rank: i + 1,
    score: parseFloat(r.similarity),
  }));
}

/** BM25 full-text search against fact_units table */
async function factBm25Search(
  apiKeyId: string,
  agentId: string,
  query: string,
  limit: number = 100,
): Promise<{ id: string; rank: number }[]> {
  try {
    const results = await sql`
      SELECT id,
        ts_rank_cd(search_vector, plainto_tsquery('english', ${query})) as bm25_score
      FROM fact_units
      WHERE api_key_id = ${apiKeyId}
        AND agent_id = ${agentId}
        AND search_vector @@ plainto_tsquery('english', ${query})
      ORDER BY bm25_score DESC
      LIMIT ${limit}
    `;
    return (results as any[]).map((r: any, i: number) => ({ id: r.id, rank: i + 1 }));
  } catch (err: any) {
    if (err.code === "42703" || err.message?.includes("search_vector")) {
      return [];
    }
    throw err;
  }
}

/**
 * Graph traversal with dual-seed entry (vector + entity name).
 * Seeds from both embedding similarity AND entity name matching,
 * then expands through entity links and causal links.
 */
async function graphSearch(
  apiKeyId: string,
  agentId: string,
  queryVector: number[],
  queryText: string,
  limit: number = 50,
): Promise<{ id: string; rank: number }[]> {
  const vecStr = `[${queryVector.join(",")}]`;

  try {
    // Single CTE: dual-seed → entity expansion → causal expansion → merge
    const results = await sql`
      WITH vector_seeds AS (
        SELECT id, 1 - (embedding_vec <=> ${vecStr}::vector) as score
        FROM fact_units
        WHERE api_key_id = ${apiKeyId} AND agent_id = ${agentId}
          AND embedding_vec IS NOT NULL
        ORDER BY embedding_vec <=> ${vecStr}::vector
        LIMIT 20
      ),
      entity_seeds AS (
        SELECT DISTINCT ef.fact_id as id, similarity(e.canonical, lower(${queryText})) * 0.8 as score
        FROM entities e
        JOIN entity_facts ef ON e.id = ef.entity_id
        WHERE e.api_key_id = ${apiKeyId} AND e.agent_id = ${agentId}
          AND similarity(e.canonical, lower(${queryText})) > 0.2
        LIMIT 20
      ),
      all_seeds AS (
        SELECT id, MAX(score) as score FROM (
          SELECT * FROM vector_seeds
          UNION ALL
          SELECT * FROM entity_seeds
        ) combined
        GROUP BY id
      ),
      entity_expansion AS (
        SELECT DISTINCT ef2.fact_id as id,
          LEAST(1.0, COUNT(DISTINCT ef1.entity_id)::real * 0.3) as score
        FROM entity_facts ef1
        JOIN all_seeds s ON ef1.fact_id = s.id
        JOIN entity_facts ef2 ON ef1.entity_id = ef2.entity_id AND ef2.fact_id != s.id
        GROUP BY ef2.fact_id
        LIMIT 50
      ),
      causal_expansion AS (
        SELECT to_fact_id as id, weight * 0.5 as score
        FROM fact_links
        WHERE from_fact_id IN (SELECT id FROM all_seeds)
          AND link_type = 'causal'
        LIMIT 50
      )
      SELECT id, SUM(score) as total_score FROM (
        SELECT * FROM all_seeds
        UNION ALL SELECT * FROM entity_expansion
        UNION ALL SELECT * FROM causal_expansion
      ) merged
      GROUP BY id
      ORDER BY total_score DESC
      LIMIT ${limit}
    `;

    return (results as any[]).map((r: any, i: number) => ({
      id: r.id,
      rank: i + 1,
    }));
  } catch (err: any) {
    console.warn("[graph-search] Graph traversal failed:", err.message);
    return [];
  }
}

/**
 * Temporal search: find facts by date proximity to dates mentioned in the query.
 * Uses date-parser.ts to extract dates from the query text.
 */
async function factTemporalSearch(
  apiKeyId: string,
  agentId: string,
  queryText: string,
  queryVector: number[],
  limit: number = 50,
): Promise<{ id: string; rank: number }[]> {
  // Extract dates from the query
  const parsed = parseDates(queryText);
  if (!parsed.eventDateFrom) return []; // No date in query, skip this strategy

  const targetDate = parsed.eventDateFrom;
  const vecStr = `[${queryVector.join(",")}]`;

  try {
    // Phase 1: find facts near the target date, scored by proximity
    // Phase 2: re-rank by embedding similarity within the date-proximate set
    const results = await sql`
      WITH date_candidates AS (
        SELECT id,
          1.0 - LEAST(1.0,
            EXTRACT(EPOCH FROM ABS(event_date_from - ${targetDate}::timestamptz)) / (86400 * 30)
          ) as date_score
        FROM fact_units
        WHERE api_key_id = ${apiKeyId} AND agent_id = ${agentId}
          AND event_date_from IS NOT NULL
          AND event_date_from BETWEEN (${targetDate}::timestamptz - interval '90 days')
                                 AND (${targetDate}::timestamptz + interval '90 days')
        ORDER BY ABS(EXTRACT(EPOCH FROM (event_date_from - ${targetDate}::timestamptz)))
        LIMIT 50
      )
      SELECT dc.id,
        dc.date_score * 0.6 + (1 - (f.embedding_vec <=> ${vecStr}::vector)) * 0.4 as combined_score
      FROM date_candidates dc
      JOIN fact_units f ON dc.id = f.id
      WHERE f.embedding_vec IS NOT NULL
      ORDER BY combined_score DESC
      LIMIT ${limit}
    `;

    return (results as any[]).map((r: any, i: number) => ({
      id: r.id,
      rank: i + 1,
    }));
  } catch (err: any) {
    console.warn("[temporal-search] Temporal search failed:", err.message);
    return [];
  }
}

/** Strategy metrics for observability */
interface StrategyMetrics {
  name: string;
  count: number;
  topScore: number;
  durationMs: number;
}

function logStrategyMetrics(metrics: StrategyMetrics[]): void {
  const summary = metrics
    .map((m) => `${m.name}=${m.count} (${m.durationMs}ms)`)
    .join(", ");
  console.log(`[recall] Strategy hits: ${summary}`);
}

/**
 * Facade: map fact_unit IDs back to parent memory objects.
 * Groups facts by memory_id, fetches parent memories, returns Memory shape.
 */
async function facadeFactsToMemories(
  factIds: string[],
  rawApiKey: string,
): Promise<Map<string, any>> {
  if (factIds.length === 0) return new Map();

  // Get memory_ids for all fact_ids
  const factRows = await sql`
    SELECT id as fact_id, memory_id, created_at FROM fact_units WHERE id = ANY(${factIds})
  `;
  const memoryIds = [...new Set((factRows as any[]).map((r: any) => r.memory_id))];

  if (memoryIds.length === 0) return new Map();

  // Fetch parent memories
  const memories = await sql`
    SELECT id, agent_id, user_id, org_id, scope, content, tags, created_at, updated_at
    FROM memories WHERE id = ANY(${memoryIds}) AND deleted_at IS NULL
  `;

  // Build fact_id → memory lookup
  const factToMemory = new Map<string, any>();
  const memoryMap = new Map<string, any>();
  for (const m of memories as any[]) {
    memoryMap.set(m.id, m);
  }
  for (const r of factRows as any[]) {
    const mem = memoryMap.get(r.memory_id);
    if (mem) factToMemory.set(r.fact_id, mem);
  }

  return factToMemory;
}

// --- Recall (4-way hybrid retrieval on fact_units, fallback to memories) ---

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
    dateFrom,
    dateTo,
  } = params;

  const queryVector = await embed(query);

  // Check fact_units availability (cached after first call)
  if (_factUnitsAvailable === null) {
    _factUnitsAvailable = await checkFactUnitsAvailable();
    console.log(`[recall] fact_units available: ${_factUnitsAvailable}`);
  }

  // Check pgvector availability (cached after first call)
  if (_pgvectorAvailable === null) {
    _pgvectorAvailable = await isPgvectorAvailable();
    console.log(`[recall] pgvector available: ${_pgvectorAvailable}`);
  }

  // === Route: fact-based 4-way retrieval OR legacy memory-based ===
  if (_factUnitsAvailable) {
    return recallFromFacts(params, queryVector);
  } else {
    return recallFromMemories(params, queryVector);
  }
}

/**
 * 4-way parallel retrieval on fact_units with facade back to memory objects.
 * Strategies: vector, BM25, graph traversal, temporal.
 */
async function recallFromFacts(
  params: RecallParams,
  queryVector: number[],
): Promise<MemoryWithScore[]> {
  const { apiKeyId, rawApiKey, agentId, query, limit = 10 } = params;
  const metrics: StrategyMetrics[] = [];

  // Run all 4 strategies in parallel
  const [vectorResults, bm25Results, graphResults, temporalResults] = await Promise.all([
    timedStrategy("vector", () => factVectorSearch(apiKeyId, agentId, queryVector, 200)),
    timedStrategy("bm25", () => factBm25Search(apiKeyId, agentId, query, 100)),
    timedStrategy("graph", () => graphSearch(apiKeyId, agentId, queryVector, query, 50)),
    timedStrategy("temporal", () => factTemporalSearch(apiKeyId, agentId, query, queryVector, 50)),
  ]);

  // Collect metrics
  metrics.push(
    { name: "vector", count: vectorResults.results.length, topScore: 0, durationMs: vectorResults.ms },
    { name: "bm25", count: bm25Results.results.length, topScore: 0, durationMs: bm25Results.ms },
    { name: "graph", count: graphResults.results.length, topScore: 0, durationMs: graphResults.ms },
    { name: "temporal", count: temporalResults.results.length, topScore: 0, durationMs: temporalResults.ms },
  );
  logStrategyMetrics(metrics);

  // RRF fusion across all strategy results
  const rankedLists = [
    vectorResults.results,
    bm25Results.results,
    graphResults.results,
    temporalResults.results,
  ].filter((list) => list.length > 0);

  if (rankedLists.length === 0) {
    return [];
  }

  const fusedScores = rankedLists.length > 1
    ? reciprocalRankFusion(rankedLists)
    : new Map(rankedLists[0].map((item) => [item.id, 1 / (60 + item.rank)]));

  // Get all fact IDs for facade lookup
  const allFactIds = [...fusedScores.keys()];
  const factToMemory = await facadeFactsToMemories(allFactIds, rawApiKey);

  // Build scored memory list (deduplicate by memory ID, keep best fact score)
  const memoryScores = new Map<string, { memory: any; score: number }>();
  for (const [factId, rrfScore] of fusedScores.entries()) {
    const mem = factToMemory.get(factId);
    if (!mem) continue;

    const decay = temporalDecay(mem.created_at);
    const finalScore = rrfScore * 0.85 + decay * rrfScore * 0.15;

    const existing = memoryScores.get(mem.id);
    if (!existing || finalScore > existing.score) {
      memoryScores.set(mem.id, { memory: mem, score: finalScore });
    }
  }

  // Sort by score, build MemoryWithScore array
  const finalScored: MemoryWithScore[] = [...memoryScores.values()]
    .sort((a, b) => b.score - a.score)
    .map(({ memory: m, score }) => ({
      id: m.id,
      agent_id: m.agent_id,
      user_id: m.user_id,
      org_id: m.org_id,
      scope: m.scope,
      content: m.content,
      tags: m.tags,
      created_at: m.created_at,
      updated_at: m.updated_at,
      relevance_score: Math.round(score * 10000) / 10000,
    }));

  // Decrypt top candidates for reranking
  const rerankCandidateCount = Math.min(finalScored.length, Math.max(limit * 5, 100));
  const topCandidates = finalScored.slice(0, rerankCandidateCount);
  const decryptedCandidates = topCandidates.map((m) => ({
    ...m,
    content: decrypt(m.content, rawApiKey),
  }));

  // Cross-encoder reranking
  const rerankDocs = decryptedCandidates.map((m) => ({ id: m.id, content: m.content }));
  const reranked = await rerank(query, rerankDocs, limit);

  const rerankedMap = new Map(decryptedCandidates.map((m) => [m.id, m]));
  const decrypted = reranked.map((r) => {
    const m = rerankedMap.get(r.id)!;
    return { ...m, relevance_score: Math.round(r.score * 10000) / 10000 };
  });

  // Track usage
  await sql`
    INSERT INTO usage_events (api_key_id, event_type, agent_id, tokens)
    VALUES (${apiKeyId}, 'recall', ${agentId}, ${embeddingTokenEstimate(query)})
  `;

  return decrypted;
}

/** Helper: time a strategy execution */
async function timedStrategy<T extends { id: string; rank: number }[]>(
  name: string,
  fn: () => Promise<T>,
): Promise<{ results: T; ms: number }> {
  const start = Date.now();
  try {
    const results = await fn();
    return { results, ms: Date.now() - start };
  } catch (err: any) {
    console.warn(`[recall] Strategy ${name} failed:`, err.message);
    return { results: [] as unknown as T, ms: Date.now() - start };
  }
}

/**
 * Legacy recall path: 2-way retrieval on memories table (vector + BM25).
 * Used when fact_units table is empty (pre-migration).
 */
async function recallFromMemories(
  params: RecallParams,
  queryVector: number[],
): Promise<MemoryWithScore[]> {
  const {
    apiKeyId,
    rawApiKey,
    agentId,
    query,
    scope,
    tags,
    limit = 10,
    dateFrom,
    dateTo,
  } = params;

  // Decompose query into sub-queries for broader retrieval
  const queries = await decomposeQuery(query);
  const includeShared = scope !== "agent";

  // === Strategy 1: Vector search (semantic) ===
  let vectorRanked: { id: string; rank: number }[];
  const vectorScores = new Map<string, number>();
  const memoryMap = new Map<string, any>();

  if (_pgvectorAvailable) {
    const pgResults = await pgvectorSearch(
      apiKeyId, agentId, queryVector, 200, dateFrom, dateTo, includeShared
    );
    for (const r of pgResults) {
      vectorScores.set(r.id, r.score);
    }

    for (const subQuery of queries.slice(1)) {
      try {
        const subVector = await embed(subQuery);
        const subResults = await pgvectorSearch(
          apiKeyId, agentId, subVector, 50, dateFrom, dateTo, includeShared
        );
        for (const r of subResults) {
          const existing = vectorScores.get(r.id) || 0;
          if (r.score > existing) vectorScores.set(r.id, r.score);
        }
      } catch {}
    }

    vectorRanked = [...vectorScores.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([id], i) => ({ id, rank: i + 1 }));

    const vectorIds = vectorRanked.map((r) => r.id);
    if (vectorIds.length > 0) {
      const rows = await sql`
        SELECT id, agent_id, user_id, org_id, scope, content, tags, embedding, created_at, updated_at
        FROM memories WHERE id = ANY(${vectorIds})
      `;
      for (const row of rows) {
        memoryMap.set((row as any).id, row);
      }
    }
  } else {
    const candidates = await sql`
      SELECT id, agent_id, user_id, org_id, scope, content, tags, embedding, created_at, updated_at
      FROM memories
      WHERE api_key_id = ${apiKeyId}
        AND deleted_at IS NULL
        AND embedding IS NOT NULL
        AND agent_id = ${agentId}
      ORDER BY created_at DESC
      LIMIT 500
    `;

    let scopeMemories: any[] = [];
    if (includeShared) {
      scopeMemories = await sql`
        SELECT id, agent_id, user_id, org_id, scope, content, tags, embedding, created_at, updated_at
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
    let filtered = allCandidates;
    if (tags && tags.length > 0) {
      filtered = allCandidates.filter((m: any) => {
        const memTags = m.tags || [];
        return tags.some((t: string) => memTags.includes(t));
      });
    }

    filtered.forEach((m: any) => {
      const emb = typeof m.embedding === "string" ? JSON.parse(m.embedding) : m.embedding;
      const score = cosineSimilarity(queryVector, emb);
      vectorScores.set(m.id, score);
      memoryMap.set(m.id, m);
    });

    vectorRanked = [...vectorScores.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([id], i) => ({ id, rank: i + 1 }));
  }

  // === Strategy 2: BM25 full-text search ===
  let bm25Ranked = await bm25Search(apiKeyId, agentId, query, 100, includeShared);
  for (const subQuery of queries.slice(1)) {
    try {
      const subBm25 = await bm25Search(apiKeyId, agentId, subQuery, 30, includeShared);
      const offset = bm25Ranked.length;
      for (const r of subBm25) {
        if (!bm25Ranked.some((b) => b.id === r.id)) {
          bm25Ranked.push({ id: r.id, rank: offset + r.rank });
        }
      }
    } catch {}
  }

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

  // === RRF Fusion ===
  const rankedLists = [vectorRanked, bm25Ranked].filter((list) => list.length > 0);

  let fusedScores: Map<string, number>;
  if (rankedLists.length > 1) {
    fusedScores = reciprocalRankFusion(rankedLists);
  } else if (vectorRanked.length > 0) {
    fusedScores = new Map(vectorRanked.map((item) => [item.id, vectorScores.get(item.id) || 0]));
  } else {
    fusedScores = new Map();
  }

  // === Temporal decay ===
  const finalScored: MemoryWithScore[] = [];
  for (const [id, rrfScore] of fusedScores.entries()) {
    const m = memoryMap.get(id);
    if (!m) continue;

    const decay = temporalDecay(m.created_at);
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

  finalScored.sort((a, b) => b.relevance_score - a.relevance_score);

  // === Decrypt + rerank ===
  const rerankCandidateCount = Math.min(finalScored.length, Math.max(limit * 5, 100));
  const topCandidates = finalScored.slice(0, rerankCandidateCount);
  const decryptedCandidates = topCandidates.map((m) => ({
    ...m,
    content: decrypt(m.content, rawApiKey),
  }));

  const rerankDocs = decryptedCandidates.map((m) => ({ id: m.id, content: m.content }));
  const reranked = await rerank(query, rerankDocs, limit);

  const rerankedMap = new Map(decryptedCandidates.map((m) => [m.id, m]));
  const decrypted = reranked.map((r) => {
    const m = rerankedMap.get(r.id)!;
    return { ...m, relevance_score: Math.round(r.score * 10000) / 10000 };
  });

  // === Lazy backfill tsvectors ===
  const toBackfill = decrypted.filter((m) => {
    const mem = memoryMap.get(m.id);
    return mem && isEncrypted(mem.content) && (!mem.content_tsv || mem.content_tsv === "");
  });
  if (toBackfill.length > 0) {
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
