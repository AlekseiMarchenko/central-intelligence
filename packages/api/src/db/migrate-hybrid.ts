import { sql } from "./connection.js";

export async function migrateHybridSearch() {
  console.log("[migrate] Adding hybrid search support...");

  try {
    // Enable extensions
    await sql`CREATE EXTENSION IF NOT EXISTS pg_trgm`;
    await sql`CREATE EXTENSION IF NOT EXISTS unaccent`;
    console.log("[migrate] Extensions pg_trgm + unaccent enabled");

    // Add tsvector column
    await sql`ALTER TABLE memories ADD COLUMN IF NOT EXISTS content_tsv tsvector`;
    console.log("[migrate] Added content_tsv column");

    // Backfill existing rows
    await sql`UPDATE memories SET content_tsv = to_tsvector('english', content) WHERE content_tsv IS NULL AND content IS NOT NULL`;
    console.log("[migrate] Backfilled tsvector for existing memories");

    // Create GIN index for full-text search
    await sql`CREATE INDEX IF NOT EXISTS idx_memories_content_tsv ON memories USING gin (content_tsv) WHERE deleted_at IS NULL`;
    console.log("[migrate] Created GIN index for full-text search");

    // Create trigram index for fuzzy matching
    await sql`CREATE INDEX IF NOT EXISTS idx_memories_content_trgm ON memories USING gin (content gin_trgm_ops) WHERE deleted_at IS NULL`;
    console.log("[migrate] Created trigram index for fuzzy matching");

    console.log("[migrate] Hybrid search migration complete");
  } catch (err: any) {
    // pg_trgm might not be available on all Postgres instances
    // Gracefully degrade — vector search still works without it
    console.warn("[migrate] Hybrid search migration failed (non-fatal):", err.message);
    console.warn("[migrate] Falling back to vector-only search");
  }
}

// Run directly if called as script
if (process.argv[1]?.endsWith("migrate-hybrid.ts") || process.argv[1]?.endsWith("migrate-hybrid.js")) {
  migrateHybridSearch()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
