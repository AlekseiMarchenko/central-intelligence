import { sql } from "./connection.js";

export async function migrateHybridSearch() {
  console.log("[migrate] Adding hybrid search support...");

  try {
    // Add tsvector column (idempotent)
    await sql`ALTER TABLE memories ADD COLUMN IF NOT EXISTS content_tsv tsvector`;
    console.log("[migrate] Ensured content_tsv column exists");

    // Create GIN index for full-text search (CONCURRENTLY to avoid locking)
    // Note: CREATE INDEX CONCURRENTLY cannot run inside a transaction.
    // If this fails (e.g., index already exists), it's safe to ignore.
    try {
      await sql`CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_memories_content_tsv ON memories USING gin (content_tsv) WHERE deleted_at IS NULL`;
      console.log("[migrate] Created GIN index for full-text search");
    } catch (err: any) {
      // CONCURRENTLY can fail if another migration is running
      if (err.message?.includes("already exists")) {
        console.log("[migrate] GIN index already exists, skipping");
      } else {
        console.warn("[migrate] GIN index creation failed (non-fatal):", err.message);
      }
    }

    // Drop old trigram index if it exists (trigram search removed — it operated
    // on encrypted ciphertext and produced meaningless results)
    try {
      await sql`DROP INDEX IF EXISTS idx_memories_content_trgm`;
      console.log("[migrate] Dropped obsolete trigram index");
    } catch {
      // Ignore — index might not exist
    }

    // Note: We do NOT backfill tsvectors here because content is encrypted and
    // we don't have the API keys to decrypt. Tsvectors are populated:
    // 1. On new INSERTs: store() generates tsvector from plaintext before encrypting
    // 2. Lazy backfill: recall() updates tsvectors when memories are decrypted

    console.log("[migrate] Hybrid search migration complete (vector + BM25)");
  } catch (err: any) {
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
