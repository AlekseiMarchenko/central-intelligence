import { sql } from "./connection.js";

/**
 * Fact decomposition migration — creates tables for structured fact storage,
 * entity resolution, and knowledge graph links.
 *
 * Tables: fact_units, entities, entity_facts, entity_cooccurrences, fact_links
 * Also adds extraction_status/extraction_retries columns to memories.
 */
export async function migrateFacts() {
  // Step 1: Enable pg_trgm for entity fuzzy matching
  try {
    await sql`CREATE EXTENSION IF NOT EXISTS pg_trgm`;
    console.log("[facts] pg_trgm extension ready");
  } catch (err: any) {
    console.warn("[facts] pg_trgm not available:", err.message);
  }

  // Step 2: Add extraction tracking columns to memories
  try {
    await sql`ALTER TABLE memories ADD COLUMN IF NOT EXISTS extraction_status TEXT DEFAULT 'pending'`;
    await sql`ALTER TABLE memories ADD COLUMN IF NOT EXISTS extraction_retries INTEGER DEFAULT 0`;
    console.log("[facts] Extraction tracking columns ready");
  } catch (err: any) {
    console.warn("[facts] Extraction columns skipped:", err.message);
  }

  // Step 3: Create fact_units table
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS fact_units (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        memory_id UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
        api_key_id UUID NOT NULL,
        agent_id TEXT NOT NULL,
        fact_text TEXT NOT NULL,
        fact_type TEXT NOT NULL DEFAULT 'world',
        embedding_vec vector(1536),
        search_vector TSVECTOR,
        event_date_from TIMESTAMPTZ,
        event_date_to TIMESTAMPTZ,
        entities JSONB,
        metadata JSONB,
        proof_count INTEGER DEFAULT 1,
        source_fact_ids UUID[],
        is_fallback BOOLEAN DEFAULT false,
        created_at TIMESTAMPTZ DEFAULT now()
      )
    `;
    console.log("[facts] fact_units table ready");
  } catch (err: any) {
    console.warn("[facts] fact_units creation skipped:", err.message);
  }

  // Step 4: Create entities table
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS entities (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        api_key_id UUID NOT NULL,
        agent_id TEXT NOT NULL,
        name TEXT NOT NULL,
        canonical TEXT NOT NULL,
        entity_type TEXT DEFAULT 'unknown',
        mention_count INTEGER DEFAULT 1,
        last_seen TIMESTAMPTZ DEFAULT now(),
        UNIQUE(api_key_id, agent_id, canonical)
      )
    `;
    console.log("[facts] entities table ready");
  } catch (err: any) {
    console.warn("[facts] entities creation skipped:", err.message);
  }

  // Step 5: Create entity_facts junction
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS entity_facts (
        entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
        fact_id UUID NOT NULL REFERENCES fact_units(id) ON DELETE CASCADE,
        PRIMARY KEY (entity_id, fact_id)
      )
    `;
    console.log("[facts] entity_facts table ready");
  } catch (err: any) {
    console.warn("[facts] entity_facts creation skipped:", err.message);
  }

  // Step 6: Create entity_cooccurrences
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS entity_cooccurrences (
        entity_a UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
        entity_b UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
        count INTEGER DEFAULT 1,
        PRIMARY KEY (entity_a, entity_b)
      )
    `;
    console.log("[facts] entity_cooccurrences table ready");
  } catch (err: any) {
    console.warn("[facts] entity_cooccurrences creation skipped:", err.message);
  }

  // Step 7: Create fact_links
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS fact_links (
        from_fact_id UUID NOT NULL REFERENCES fact_units(id) ON DELETE CASCADE,
        to_fact_id UUID NOT NULL REFERENCES fact_units(id) ON DELETE CASCADE,
        link_type TEXT NOT NULL,
        weight REAL DEFAULT 1.0,
        PRIMARY KEY (from_fact_id, to_fact_id, link_type)
      )
    `;
    console.log("[facts] fact_links table ready");
  } catch (err: any) {
    console.warn("[facts] fact_links creation skipped:", err.message);
  }

  // Step 8: Indexes — each in its own try/catch (CONCURRENTLY can't run in transaction)
  try {
    await sql`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_fact_units_world_vec
      ON fact_units USING hnsw (embedding_vec vector_cosine_ops)
      WITH (m = 16, ef_construction = 200)
      WHERE fact_type = 'world'
    `;
  } catch (err: any) {
    console.warn("[facts] world HNSW index skipped:", err.message);
  }

  try {
    await sql`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_fact_units_experience_vec
      ON fact_units USING hnsw (embedding_vec vector_cosine_ops)
      WITH (m = 16, ef_construction = 200)
      WHERE fact_type = 'experience'
    `;
  } catch (err: any) {
    console.warn("[facts] experience HNSW index skipped:", err.message);
  }

  try {
    await sql`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_fact_units_observation_vec
      ON fact_units USING hnsw (embedding_vec vector_cosine_ops)
      WITH (m = 16, ef_construction = 200)
      WHERE fact_type = 'observation'
    `;
  } catch (err: any) {
    console.warn("[facts] observation HNSW index skipped:", err.message);
  }

  try {
    await sql`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_fact_units_tsv
      ON fact_units USING gin (search_vector)
    `;
  } catch (err: any) {
    console.warn("[facts] tsvector index skipped:", err.message);
  }

  try {
    await sql`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_fact_units_memory
      ON fact_units (memory_id)
    `;
  } catch (err: any) {
    console.warn("[facts] memory_id index skipped:", err.message);
  }

  try {
    await sql`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_fact_units_api_agent
      ON fact_units (api_key_id, agent_id, fact_type)
    `;
  } catch (err: any) {
    console.warn("[facts] api_agent index skipped:", err.message);
  }

  try {
    await sql`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_entities_trgm
      ON entities USING gin (canonical gin_trgm_ops)
    `;
  } catch (err: any) {
    console.warn("[facts] trigram index skipped:", err.message);
  }

  try {
    await sql`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_entities_api_agent
      ON entities (api_key_id, agent_id)
    `;
  } catch (err: any) {
    console.warn("[facts] entities api_agent index skipped:", err.message);
  }

  try {
    await sql`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_entity_facts_fact
      ON entity_facts (fact_id)
    `;
  } catch (err: any) {
    console.warn("[facts] entity_facts fact index skipped:", err.message);
  }

  try {
    await sql`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_fact_links_from
      ON fact_links (from_fact_id, link_type)
    `;
  } catch (err: any) {
    console.warn("[facts] fact_links from index skipped:", err.message);
  }

  try {
    await sql`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_fact_links_to
      ON fact_links (to_fact_id, link_type)
    `;
  } catch (err: any) {
    console.warn("[facts] fact_links to index skipped:", err.message);
  }

  // Step 9: Mark already-enriched memories as having completed extraction
  // (so the backfill job doesn't re-process them)
  try {
    const result = await sql`
      UPDATE memories
      SET extraction_status = 'complete'
      WHERE extraction_status = 'pending'
        AND enriched_at IS NOT NULL
    `;
    if (result.count > 0) {
      console.log(`[facts] Backfilled extraction_status for ${result.count} enriched memories`);
    }
  } catch (err: any) {
    console.warn("[facts] Backfill skipped:", err.message);
  }

  console.log("[facts] Migration complete");
}
