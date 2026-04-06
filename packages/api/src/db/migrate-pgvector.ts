import { sql } from "./connection.js";

/**
 * pgvector migration — adds native vector column and HNSW index.
 * Runs on startup alongside migrateHybridSearch().
 *
 * The embedding_vec column stores the same data as the JSONB embedding column
 * but in pgvector's native format for efficient ANN search via the <=> operator.
 */
export async function migratePgvector() {
  // Step 1: Check if pgvector is already loaded (fast path)
  try {
    const check = await sql`SELECT 1 FROM pg_extension WHERE extname = 'vector'`;
    if (check.length > 0) {
      console.log("[pgvector] Extension already enabled");
    } else {
      // Try to create it with a timeout — if the .so file is missing, this hangs
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("pgvector CREATE EXTENSION timed out")), 5000)
      );
      await Promise.race([
        sql`CREATE EXTENSION IF NOT EXISTS vector`,
        timeout,
      ]);
      console.log("[pgvector] Extension enabled");
    }
  } catch (err: any) {
    console.warn("[pgvector] Extension not available, falling back to in-app vector search:", err.message);
    return;
  }

  // Step 2: Add native vector column
  try {
    await sql`ALTER TABLE memories ADD COLUMN IF NOT EXISTS embedding_vec vector(1536)`;
    console.log("[pgvector] Column embedding_vec ready");
  } catch (err: any) {
    console.warn("[pgvector] Failed to add column:", err.message);
    return;
  }

  // Step 3: Backfill existing JSONB embeddings to native vector format
  try {
    let totalBackfilled = 0;
    const BATCH_SIZE = 500;
    while (true) {
      // The embedding column stores JSONB strings (not arrays) because the insert
      // does JSON.stringify(array)::jsonb which produces a JSONB string type.
      // We need to parse the string back to an array first, then convert to vector.
      // For JSONB string type: embedding #>> '{}' extracts the raw text value,
      // which is already in [n1,n2,...] format that pgvector accepts.
      const batch = await sql`
        UPDATE memories
        SET embedding_vec = (embedding #>> '{}')::vector
        WHERE id IN (
          SELECT id FROM memories
          WHERE embedding_vec IS NULL
            AND embedding IS NOT NULL
            AND deleted_at IS NULL
          LIMIT ${BATCH_SIZE}
        )
        RETURNING id
      `;
      if (batch.count === 0) break;
      totalBackfilled += batch.count;
      console.log(`[pgvector] Backfilled ${totalBackfilled} embeddings so far...`);
    }
    if (totalBackfilled > 0) {
      console.log(`[pgvector] Backfill complete: ${totalBackfilled} embeddings converted`);
    } else {
      console.log("[pgvector] No embeddings to backfill");
    }
  } catch (err: any) {
    console.warn("[pgvector] Backfill failed (will retry next startup):", err.message);
    // Don't return — still try to create the index for any already-converted vectors
  }

  // Step 4: Create HNSW index
  try {
    await sql`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_memories_embedding_vec
      ON memories USING hnsw (embedding_vec vector_cosine_ops)
      WITH (m = 16, ef_construction = 200)
    `;
    console.log("[pgvector] HNSW index ready");
  } catch (err: any) {
    console.warn("[pgvector] Index creation failed:", err.message);
  }
}

/**
 * Check whether pgvector is usable — the extension exists and the column has data.
 */
export async function isPgvectorAvailable(): Promise<boolean> {
  try {
    const result = await sql`
      SELECT EXISTS (
        SELECT 1 FROM memories WHERE embedding_vec IS NOT NULL LIMIT 1
      ) as has_data
    `;
    return result[0].has_data === true;
  } catch {
    return false;
  }
}
