import { sql } from "./connection.js";

/**
 * Enrichment migration — adds columns for async entity/preference extraction.
 */
export async function migrateEnrichment() {
  try {
    await sql`ALTER TABLE memories ADD COLUMN IF NOT EXISTS entities JSONB`;
    await sql`ALTER TABLE memories ADD COLUMN IF NOT EXISTS preferences JSONB`;
    await sql`ALTER TABLE memories ADD COLUMN IF NOT EXISTS enriched_at TIMESTAMPTZ`;
    console.log("[enrichment] Columns ready");
  } catch (err: any) {
    console.warn("[enrichment] Column migration skipped:", err.message);
  }

  try {
    await sql`
      CREATE INDEX IF NOT EXISTS idx_memories_entities
      ON memories USING gin (entities)
      WHERE deleted_at IS NULL AND entities IS NOT NULL
    `;
    await sql`
      CREATE INDEX IF NOT EXISTS idx_memories_preferences
      ON memories USING gin (preferences)
      WHERE deleted_at IS NULL AND preferences IS NOT NULL
    `;
    console.log("[enrichment] Indexes ready");
  } catch (err: any) {
    console.warn("[enrichment] Index creation skipped:", err.message);
  }
}
