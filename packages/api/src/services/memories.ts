import { sql } from "../db/connection.js";
import { embed, embedBatch, embeddingTokenEstimate } from "./embeddings.js";
import { encrypt, decrypt, isEncrypted } from "./encryption.js";
import { rerank } from "./rerank.js";
import { isPgvectorAvailable } from "../db/migrate-pgvector.js";
import { parseDates } from "./date-parser.js";
import { extractFacts } from "./fact-extraction.js";
import {
  resolveEntities,
  updateCooccurrences,
  linkEntitiesToFacts,
  clearEntityCache,
} from "./entity-resolution.js";

/** Validate a date string — returns null if it can't be parsed as a valid date. */
function safeDate(val: string | null | undefined): string | null {
  if (!val) return null;
  try {
    const d = new Date(val);
    if (isNaN(d.getTime())) return null;
    return d.toISOString();
  } catch {
    return null;
  }
}

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
  includeShared: boolean = false,
  dateFrom?: string,
  dateTo?: string,
): Promise<{ id: string; rank: number }[]> {
  try {
    const hasDateFilter = dateFrom || dateTo;
    const effectiveDateFrom = dateFrom || "1970-01-01T00:00:00Z";
    const effectiveDateTo = dateTo || "2099-12-31T23:59:59Z";

    // Date filter clause: NULL event_dates always pass through (dateless memories)
    const results = includeShared
      ? hasDateFilter
        ? await sql`
            SELECT id,
              ts_rank_cd(content_tsv, plainto_tsquery('english', ${query})) as bm25_score
            FROM memories
            WHERE api_key_id = ${apiKeyId}
              AND deleted_at IS NULL
              AND content_tsv @@ plainto_tsquery('english', ${query})
              AND (agent_id = ${agentId} OR scope IN ('user', 'org'))
              AND (event_date_from IS NULL
                OR (event_date_to >= ${effectiveDateFrom}::timestamptz
                    AND event_date_from <= ${effectiveDateTo}::timestamptz))
            ORDER BY bm25_score DESC
            LIMIT ${limit}
          `
        : await sql`
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
      : hasDateFilter
        ? await sql`
            SELECT id,
              ts_rank_cd(content_tsv, plainto_tsquery('english', ${query})) as bm25_score
            FROM memories
            WHERE api_key_id = ${apiKeyId}
              AND agent_id = ${agentId}
              AND deleted_at IS NULL
              AND content_tsv @@ plainto_tsquery('english', ${query})
              AND (event_date_from IS NULL
                OR (event_date_to >= ${effectiveDateFrom}::timestamptz
                    AND event_date_from <= ${effectiveDateTo}::timestamptz))
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

/** pgvector ANN search on memories table. */
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

  // Shared memories (user/org scope) — merge and sort by similarity
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

  // Sort combined results by similarity so shared memories compete fairly
  allResults.sort((a: any, b: any) => parseFloat(b.similarity) - parseFloat(a.similarity));

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

  // Track usage
  await sql`
    INSERT INTO usage_events (api_key_id, event_type, agent_id, tokens)
    VALUES (${apiKeyId}, 'remember', ${agentId}, ${embeddingTokenEstimate(content)})
  `;

  return result;
}

// --- Fact extraction (DB-driven, no in-memory queue) ---
//
// The extraction pipeline uses the DB as the job queue:
//   - extraction_status = 'pending'    → ready to process
//   - extraction_status = 'processing' → currently being worked on
//   - extraction_status = 'complete'   → done
//   - extraction_status = 'failed'     → failed, can be retried
//
// No in-memory queue, no slot counters, no drain functions.
// If the process dies, 'processing' rows are recovered on the next run.

const MAX_EXTRACTION_CONCURRENCY = parseInt(process.env.MAX_EXTRACTION_CONCURRENCY || "3");
const EXTRACTION_TIMEOUT_MS = parseInt(process.env.EXTRACTION_TIMEOUT_MS || "60000");

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

/**
 * Fire-and-forget single extraction for the inline store() path.
 * Uses AbortController to cancel the extraction when the timeout fires,
 * preventing zombie processExtraction calls that could race with batch re-runs.
 */
function fireAndForgetExtraction(params: ExtractionParams): void {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
    sql`UPDATE memories SET extraction_status = 'failed' WHERE id = ${params.memoryId}`.catch(() => {});
  }, EXTRACTION_TIMEOUT_MS);

  processExtraction(params, controller.signal)
    .finally(() => clearTimeout(timer))
    .catch(() => {});
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
 * Single attempt, no retries. Failed memories can be re-queued via
 * POST /memories/extract. Retries were causing zombie processExtraction
 * calls that saturated the OpenAI connection pool after Promise.race timeout.
 */
async function processExtraction(params: ExtractionParams, signal?: AbortSignal): Promise<void> {
  const { memoryId, apiKeyId, agentId, rawApiKey, plaintext, fallbackFactId, eventFrom, eventTo } = params;

  try {
    if (signal?.aborted) return;
    await sql`UPDATE memories SET extraction_status = 'processing' WHERE id = ${memoryId}`;

      // Step 1: Extract structured facts
      if (signal?.aborted) return;
      const extraction = await extractFacts(plaintext);
      if (extraction.facts.length === 0 && extraction.preferences.length === 0) {
        // Nothing to extract — keep the fallback, mark complete
        await sql`UPDATE memories SET extraction_status = 'complete' WHERE id = ${memoryId}`;
        return;
      }

      // Step 2: Insert fact_units with individual embeddings
      const factIds: string[] = [];
      const allEntityNames: Array<{ name: string; type?: string }> = [];

      // Batch embed all facts in one API call (~200ms instead of ~200ms × N)
      if (signal?.aborted) return;
      const factTexts = extraction.facts.map((f) => f.what);
      const factEmbeddings = factTexts.length > 0 ? await embedBatch(factTexts) : [];

      for (let i = 0; i < extraction.facts.length; i++) {
        const fact = extraction.facts[i];
        const factEmbedding = factEmbeddings[i];
        const encryptedFact = encrypt(fact.what, rawApiKey);
        const factVecStr = `[${factEmbedding.join(",")}]`;
        // Validate dates from LLM output — GPT might return "mid-January", "last week", etc.
        const factEventFrom = safeDate(fact.when?.start) || eventFrom;
        const factEventTo = safeDate(fact.when?.end) || eventTo;
        const entityNames = fact.entities.length > 0 ? JSON.stringify(fact.entities) : null;

        // Build enriched search text: fact + entities + topics for BM25 discoverability
        const searchParts = [fact.what];
        if (fact.entities.length > 0) searchParts.push(fact.entities.join(" "));
        if (fact.topics && fact.topics.length > 0) searchParts.push(fact.topics.join(" "));
        if (fact.who.length > 0) searchParts.push(fact.who.map((w) => w.name).join(" "));
        const searchText = searchParts.join(" ");

        const [inserted] = await sql`
          INSERT INTO fact_units (
            memory_id, api_key_id, agent_id, fact_text, fact_type,
            embedding_vec, search_vector, event_date_from, event_date_to, entities
          )
          VALUES (
            ${memoryId}, ${apiKeyId}, ${agentId}, ${encryptedFact}, ${fact.fact_type},
            ${factVecStr}::vector, to_tsvector('english', ${searchText}),
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
        // Extract entity types from who[] field
        for (const person of fact.who) {
          if (!allEntityNames.some((e) => e.name.toLowerCase() === person.name.toLowerCase())) {
            allEntityNames.push({ name: person.name, type: "person" });
          }
        }
      }

      // Entity resolution, linking, co-occurrences, and temporal links are
      // DEFERRED to buildEntityGraph(). Entity names are in fact_units.entities JSONB.
      //
      // Causal relations are persisted NOW because they're fact-to-fact links
      // (no entity resolution needed) and graphSearch() uses them for expansion.
      if (factIds.length > 0) {
        for (let i = 0; i < extraction.facts.length; i++) {
          const fact = extraction.facts[i];
          const fromFactId = factIds[i];
          if (fact.causal_relations && fact.causal_relations.length > 0) {
            // Link this fact to subsequent facts that it causes/enables.
            // Causal relations are directional: this fact → related facts in same memory.
            for (let j = i + 1; j < factIds.length; j++) {
              // Check if any causal relation text matches the target fact
              const targetFact = extraction.facts[j];
              for (const relation of fact.causal_relations) {
                if (targetFact.what.toLowerCase().includes(relation.toLowerCase().substring(0, 20))) {
                  try {
                    await sql`
                      INSERT INTO fact_links (from_fact_id, to_fact_id, link_type, weight)
                      VALUES (${fromFactId}, ${factIds[j]}, 'causal', 0.8)
                      ON CONFLICT DO NOTHING
                    `;
                  } catch {}
                  break;
                }
              }
            }
          }
        }
      }

      // Step 8: Delete the fallback fact_unit ONLY if real facts were created.
      // If extraction returned preferences but zero facts, keep the fallback
      // so the memory remains discoverable in the fact_units search path.
      if (extraction.facts.length > 0) {
        await sql`DELETE FROM fact_units WHERE id = ${fallbackFactId}`;
      }

      // Step 9: Populate legacy JSONB columns for backward compat
      const allEntities = allEntityNames.map((e) => e.name);
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

      // Entity resolution, co-occurrences, temporal links, and observations
      // are built in a separate bulk pass via POST /memories/build-graph.
      // This decoupling eliminates concurrency bugs during extraction.

  } catch (err: any) {
    console.warn(`[fact-extraction] Failed for memory ${memoryId}:`, err.message);
    await sql`UPDATE memories SET extraction_status = 'failed', extraction_retries = extraction_retries + 1 WHERE id = ${memoryId}`.catch(() => {});
  }
}

/**
 * Process a single batch of pending memories. Internal helper for processPendingMemories.
 * Returns batch counts. The outer function loops until no work remains.
 */
async function processOneBatch(
  apiKeyId: string,
  rawApiKey: string,
): Promise<{ processed: number; failed: number; batchSize: number }> {
  // Recover stale jobs (crashed mid-extraction, stuck in 'processing')
  const recovered = await sql`
    UPDATE memories SET extraction_status = 'pending'
    WHERE api_key_id = ${apiKeyId}
      AND extraction_status = 'processing'
      AND updated_at < now() - interval '90 seconds'
    RETURNING id
  `;
  if (recovered.length > 0) {
    console.log(`[extract] Recovered ${recovered.length} stale processing jobs`);
  }

  // Fetch a batch of pending memories
  const batch = await sql`
    SELECT id, agent_id, content, event_date_from::text, event_date_to::text
    FROM memories
    WHERE api_key_id = ${apiKeyId}
      AND deleted_at IS NULL
      AND (extraction_status = 'pending' OR (extraction_status = 'failed' AND extraction_retries < 3))
    ORDER BY created_at ASC
    LIMIT ${MAX_EXTRACTION_CONCURRENCY}
  `;

  if (batch.length === 0) {
    return { processed: 0, failed: 0, batchSize: 0 };
  }

  // Mark batch as 'processing' (claim the work)
  const batchIds = (batch as any[]).map((m: any) => m.id);
  await sql`
    UPDATE memories SET extraction_status = 'processing', updated_at = now()
    WHERE id = ANY(${batchIds})
  `;

  // Process batch concurrently with per-extraction timeout
  const results = await Promise.allSettled(
    (batch as any[]).map(async (mem: any) => {
      const plaintext = decrypt(mem.content, rawApiKey);
      if (!plaintext || plaintext === mem.content) {
        await sql`UPDATE memories SET extraction_status = 'failed' WHERE id = ${mem.id}`;
        return;
      }

      // Find or create fallback — use real embedding from parent memory (Fix #2)
      const fallbacks = await sql`
        SELECT id FROM fact_units WHERE memory_id = ${mem.id} AND is_fallback = true LIMIT 1
      `;
      let fallbackId: string;
      if (fallbacks.length > 0) {
        fallbackId = (fallbacks[0] as any).id;
      } else {
        // Get parent memory's embedding vector for the fallback fact
        const parentVec = await sql`
          SELECT embedding_vec::text as vec FROM memories WHERE id = ${mem.id}
        `;
        const vecStr = parentVec.length > 0 && (parentVec[0] as any).vec
          ? (parentVec[0] as any).vec
          : null;
        if (!vecStr) {
          // No embedding on parent — generate one from plaintext
          const embedding = await embed(plaintext);
          const generatedVec = `[${embedding.join(",")}]`;
          fallbackId = await createFallbackFact(
            mem.id, apiKeyId, mem.agent_id, mem.content,
            generatedVec, plaintext, mem.event_date_from, mem.event_date_to,
          );
        } else {
          fallbackId = await createFallbackFact(
            mem.id, apiKeyId, mem.agent_id, mem.content,
            vecStr, plaintext, mem.event_date_from, mem.event_date_to,
          );
        }
      }

      // Run extraction with timeout
      await Promise.race([
        processExtraction({
          memoryId: mem.id,
          apiKeyId,
          agentId: mem.agent_id,
          rawApiKey,
          plaintext,
          fallbackFactId: fallbackId,
          eventFrom: mem.event_date_from || null,
          eventTo: mem.event_date_to || null,
        }),
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), EXTRACTION_TIMEOUT_MS)
        ),
      ]);
    })
  );

  // Count results
  let processed = 0;
  let failed = 0;
  for (let i = 0; i < results.length; i++) {
    if (results[i].status === "rejected") {
      failed++;
      const memId = (batch as any[])[i].id;
      await sql`UPDATE memories SET extraction_status = 'failed', extraction_retries = extraction_retries + 1 WHERE id = ${memId}`.catch(() => {});
    } else {
      processed++;
    }
  }

  return { processed, failed, batchSize: batch.length };
}

/**
 * Process ALL pending memories by looping through batches.
 * DB-driven async loop — no in-memory queue.
 *
 * Flow per batch:
 *   1. Recover stale 'processing' jobs (>90s old) → mark 'pending'
 *   2. Fetch batch of N 'pending' memories
 *   3. Mark them 'processing' (claim the work)
 *   4. Process batch with Promise.allSettled + per-extraction timeout
 *   5. Mark results complete/failed
 *   6. Loop until no pending work remains
 */
export async function processPendingMemories(
  apiKeyId: string,
  rawApiKey: string,
): Promise<{ processed: number; failed: number; remaining: number }> {
  let totalProcessed = 0;
  let totalFailed = 0;
  let batchNum = 0;

  while (true) {
    batchNum++;
    const batch = await processOneBatch(apiKeyId, rawApiKey);

    totalProcessed += batch.processed;
    totalFailed += batch.failed;

    console.log(`[extract] Batch ${batchNum}: ${batch.processed} complete, ${batch.failed} failed`);

    // No more pending work — exit loop
    if (batch.batchSize === 0) break;
  }

  // Final remaining count (should be 0 if no retries exhausted)
  const remaining = await sql`
    SELECT COUNT(*) as c FROM memories
    WHERE api_key_id = ${apiKeyId} AND deleted_at IS NULL
      AND (extraction_status = 'pending' OR (extraction_status = 'failed' AND extraction_retries < 3))
  `;
  const rem = parseInt((remaining[0] as any).c) || 0;

  console.log(`[extract] Done. Total: ${totalProcessed} complete, ${totalFailed} failed, ${rem} remaining`);

  // Auto-trigger entity graph building after extraction completes.
  // Without this, graph retrieval (entity_facts, fact_links) is dead.
  // Runs for each distinct agent_id that had memories processed.
  if (totalProcessed > 0 && process.env.SKIP_ENTITY_RESOLUTION !== "1") {
    try {
      const agents = await sql`
        SELECT DISTINCT agent_id FROM memories
        WHERE api_key_id = ${apiKeyId} AND extraction_status = 'complete'
      `;
      for (const row of agents as any[]) {
        console.log(`[extract] Auto-building entity graph for agent ${row.agent_id}...`);
        await buildEntityGraph(apiKeyId, row.agent_id);
      }
    } catch (err: any) {
      console.warn(`[extract] Auto graph build failed (non-fatal):`, err.message);
    }
  }

  return { processed: totalProcessed, failed: totalFailed, remaining: rem };
}

/**
 * Build the entity graph in bulk after all extractions are complete.
 * Reads entity names from fact_units.entities JSONB, resolves them,
 * links them to facts, builds co-occurrences, and creates temporal links.
 *
 * This runs as a separate pass, not inline with extraction. Eliminates
 * concurrency bugs (FK violations, stale cache, connection exhaustion)
 * that plagued the inline approach.
 *
 * Call via POST /memories/build-graph after extraction is done.
 */
export async function buildEntityGraph(
  apiKeyId: string,
  agentId: string,
): Promise<{ entities: number; links: number; temporal: number }> {
  clearEntityCache();

  // Step 1: Get all non-fallback fact_units with entity data
  const facts = await sql`
    SELECT id, entities, memory_id
    FROM fact_units
    WHERE api_key_id = ${apiKeyId}
      AND agent_id = ${agentId}
      AND is_fallback = false
      AND entities IS NOT NULL
      AND entities != 'null'::jsonb
    ORDER BY created_at ASC
  `;

  if (facts.length === 0) {
    return { entities: 0, links: 0, temporal: 0 };
  }

  console.log(`[build-graph] Processing ${facts.length} facts for entity graph...`);

  let totalEntities = 0;
  let totalLinks = 0;
  const BATCH_SIZE = 100;

  for (let batch = 0; batch < facts.length; batch += BATCH_SIZE) {
    const chunk = (facts as any[]).slice(batch, batch + BATCH_SIZE);

    for (const fact of chunk) {
      // Parse entity names from JSONB
      let entityNames: string[] = [];
      try {
        entityNames = Array.isArray(fact.entities) ? fact.entities : JSON.parse(fact.entities);
        if (!Array.isArray(entityNames)) entityNames = [];
      } catch {
        continue;
      }

      if (entityNames.length === 0) continue;

      // Resolve entities (sequential within each fact, uses cache across facts)
      const nameObjects = entityNames.map((n: string) => ({ name: n }));
      const entityNameToId = await resolveEntities(apiKeyId, agentId, nameObjects);

      // Link entities to this fact
      const linkPairs: Array<{ entityId: string; factId: string }> = [];
      for (const name of entityNames) {
        const entityId = entityNameToId.get(name);
        if (entityId) {
          linkPairs.push({ entityId, factId: fact.id });
        }
      }
      await linkEntitiesToFacts(linkPairs);
      totalLinks += linkPairs.length;
      totalEntities = Math.max(totalEntities, entityNameToId.size);

      // Co-occurrences (fire-and-forget per fact, not blocking)
      const entityIds = [...new Set([...entityNameToId.values()])];
      if (entityIds.length >= 2) {
        updateCooccurrences(entityIds).catch(() => {});
      }
    }

    console.log(`[build-graph] Processed ${Math.min(batch + BATCH_SIZE, facts.length)}/${facts.length} facts`);
  }

  // Step 2: Build temporal links across ALL facts with dates
  const allFactIds = (facts as any[]).map((f: any) => f.id);
  await buildTemporalLinks(allFactIds);
  const temporalCount = await sql`SELECT COUNT(*) as c FROM fact_links WHERE link_type = 'temporal'`;
  const temporal = parseInt((temporalCount[0] as any).c) || 0;

  console.log(`[build-graph] Done. ${totalEntities} entities, ${totalLinks} entity-fact links, ${temporal} temporal links`);
  return { entities: totalEntities, links: totalLinks, temporal };
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

  const factsWithDates = rows
    .map((r: any) => {
      const d = new Date(r.event_date_from);
      const ts = d.getTime();
      if (isNaN(ts)) return null;
      return { id: r.id, date: ts };
    })
    .filter((f): f is { id: string; date: number } => f !== null);

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

/** Vector search against fact_units table. Used by /extract endpoint, not in main recall path. */
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
    // Use OR-based tsquery for fact_units (short texts, AND-all-terms rarely matches).
    // Tokenize query, strip punctuation, join with | (OR).
    const tokens = query
      .toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 2); // skip short words
    if (tokens.length === 0) return [];
    const orQuery = tokens.join(" | ");

    const results = await sql`
      SELECT id,
        ts_rank_cd(search_vector, to_tsquery('english', ${orQuery})) as bm25_score
      FROM fact_units
      WHERE api_key_id = ${apiKeyId}
        AND agent_id = ${agentId}
        AND search_vector @@ to_tsquery('english', ${orQuery})
      ORDER BY bm25_score DESC
      LIMIT ${limit}
    `;
    return (results as any[]).map((r: any, i: number) => ({ id: r.id, rank: i + 1 }));
  } catch (err: any) {
    if (err.code === "42703" || err.message?.includes("search_vector")) {
      return [];
    }
    console.warn("[bm25-facts] BM25 search error:", err.message);
    return [];
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
  // Extract dates from the query — try explicit dates first, then month references
  const parsed = parseDates(queryText);
  if (!parsed.eventDateFrom) {
    // Try month extraction — matches anywhere in the sentence:
    // "In January", "in mid-March", "working in January?", "on January 25th"
    const monthMap: Record<string, string> = {
      january: "01", february: "02", march: "03", april: "04", may: "05", june: "06",
      july: "07", august: "08", september: "09", october: "10", november: "11", december: "12",
    };
    const ql = queryText.toLowerCase();

    // Try "Month Day" without year (e.g., "January 25th", "March 14")
    const monthDayMatch = ql.match(
      /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})(?:st|nd|rd|th)?/
    );
    if (monthDayMatch && monthMap[monthDayMatch[1]]) {
      const m = monthMap[monthDayMatch[1]];
      const d = monthDayMatch[2].padStart(2, "0");
      // Use current year as default, not hardcoded 2025.
      // Check for explicit year mentions first.
      const yearMatch = ql.match(/\b(20\d{2})\b/);
      const year = yearMatch ? yearMatch[1] : new Date().getFullYear().toString();
      parsed.eventDateFrom = `${year}-${m}-${d}T00:00:00Z`;
    }

    // Try just month name anywhere (e.g., "in January", "working in March?")
    if (!parsed.eventDateFrom) {
      const monthMatch = ql.match(
        /\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/
      );
      if (monthMatch && monthMap[monthMatch[1]]) {
        const m = monthMap[monthMatch[1]];
        // Check for explicit year, fall back to current year
        const yearMatch = ql.match(/\b(20\d{2})\b/);
        const year = yearMatch ? yearMatch[1] : new Date().getFullYear().toString();
        parsed.eventDateFrom = `${year}-${m}-15T00:00:00Z`;
      }
    }

    // Try "Spring Festival" / "Chinese New Year"
    if (!parsed.eventDateFrom && (ql.includes("spring festival") || ql.includes("chinese new year") || ql.includes("lunar new year"))) {
      parsed.eventDateFrom = "2025-01-28T00:00:00Z"; // CNY 2025
    }
  }
  if (!parsed.eventDateFrom) {
    console.log(`[temporal] No date found in query: "${queryText.substring(0, 80)}"`);
    return []; // No date in query, skip this strategy
  }

  const targetDate = parsed.eventDateFrom;
  console.log(`[temporal] Target date: ${targetDate} for query: "${queryText.substring(0, 60)}"`)
  const vecStr = `[${queryVector.join(",")}]`;

  try {
    // Phase 1: find facts near the target date, scored by proximity
    // Phase 2: re-rank by embedding similarity within the date-proximate set
    const results = await sql`
      WITH date_candidates AS (
        SELECT id,
          1.0 - LEAST(1.0,
            ABS(EXTRACT(EPOCH FROM (event_date_from - ${targetDate}::timestamptz))) / (86400 * 30)
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

// --- Query type classification (keyword-based, no LLM) ---

function classifyQueryType(query: string): "factual" | "temporal" | "pattern" | "multi-hop" {
  const q = query.toLowerCase();

  // Multi-hop: questions requiring connecting information across multiple events/memories.
  // These need full memory context (not atomic facts) to reason across events.
  if (
    /what .* led to/.test(q) ||
    /as a result of/.test(q) ||
    /connection between/.test(q) ||
    /relationship between/.test(q) ||
    /how did .* affect/.test(q) ||
    /how did .* influence/.test(q) ||
    /what happened after/.test(q) ||
    /what changed after/.test(q) ||
    /based on .* what/.test(q) ||
    /considering .* (and|with) .* what/.test(q) ||
    /both .* and/.test(q) ||
    /combine/.test(q) ||
    /taking into account/.test(q)
  ) return "multi-hop";

  // Temporal: counting, duration, date comparison, sequence, specific dates
  if (
    /how many (days|times|sessions|hours)/.test(q) ||
    /how long/.test(q) ||
    /elapsed/.test(q) ||
    /before or after/.test(q) ||
    /how many .* (this year|this month)/.test(q) ||
    /interval between/.test(q) ||
    /when was the last/.test(q) ||
    /after .* how many days/.test(q) ||
    /last (year|month|week|time)/.test(q) ||
    /\b\d{1,2}\s+(january|february|march|april|may|june|july|august|september|october|november|december)\b/.test(q) ||
    /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}/.test(q) ||
    /\b\d{4}[-\/]\d{2}[-\/]\d{2}\b/.test(q) ||
    /\b\d{1,2}[-\/]\d{1,2}[-\/]\d{4}\b/.test(q)
  ) return "temporal";

  // Pattern: habits, preferences, routines, activities
  if (
    /what (new )?(activity|habit|routine|hobby|exercise|strategy)/.test(q) ||
    /usually|typically|regularly/.test(q) ||
    /what .*challenges/.test(q) ||
    /what .*key stages/.test(q) ||
    /what .*plan/.test(q) ||
    /what .*approach/.test(q)
  ) return "pattern";

  // Default: factual (IE) — specific who/what/where/which questions
  return "factual";
}

export async function recall(params: RecallParams): Promise<MemoryWithScore[]> {
  const { query } = params;
  const queryVector = await embed(query);

  // Check pgvector availability (cached after first call)
  if (_pgvectorAvailable === null) {
    _pgvectorAvailable = await isPgvectorAvailable();
    console.log(`[recall] pgvector available: ${_pgvectorAvailable}`);
  }

  // v2 pipeline: pgvector + BM25 → RRF → temporal decay → ONNX reranker
  return recallFromMemories(params, queryVector);
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

  // NOTE: Query decomposition was tested on the facts-path but caused a -6.3 point
  // regression (46.4% → 40.1%). Sub-queries generate noise against atomic facts,
  // pulling in irrelevant fact_units that dilute good results. The memories-path
  // already has decomposition where it works well (longer documents, better signal).
  // Don't add decomposition here without per-category A/B testing.

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
  // Apply caller filters (scope, tags, dateFrom, dateTo) at the memory level.
  const { scope, tags, dateFrom, dateTo } = params;
  const memoryScores = new Map<string, { memory: any; score: number }>();
  for (const [factId, rrfScore] of fusedScores.entries()) {
    const mem = factToMemory.get(factId);
    if (!mem) continue;

    // Apply scope filter
    if (scope && mem.scope !== scope) continue;
    // Apply tags filter (memory must have ALL requested tags)
    if (tags && tags.length > 0) {
      const memTags: string[] = Array.isArray(mem.tags) ? mem.tags : [];
      if (!tags.every((t: string) => memTags.includes(t))) continue;
    }
    // Apply date filters
    if (dateFrom && mem.created_at < dateFrom) continue;
    if (dateTo && mem.created_at > dateTo) continue;

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

  const includeShared = scope !== "agent";

  // === Strategy 1: Vector search (pgvector HNSW) ===
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
  const bm25Ranked = await bm25Search(apiKeyId, agentId, query, 100, includeShared, dateFrom, dateTo);

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
