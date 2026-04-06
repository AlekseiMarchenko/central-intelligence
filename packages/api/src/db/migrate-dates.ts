import { sql } from "./connection.js";

/**
 * Content-based date indexing migration.
 * Adds event_date_from/event_date_to columns for temporal filtering
 * based on dates found in the memory content, not created_at.
 */
export async function migrateDates() {
  try {
    await sql`ALTER TABLE memories ADD COLUMN IF NOT EXISTS event_date_from TIMESTAMPTZ`;
    await sql`ALTER TABLE memories ADD COLUMN IF NOT EXISTS event_date_to TIMESTAMPTZ`;
    console.log("[dates] Event date columns ready");
  } catch (err: any) {
    // Columns may already exist or DB is read-only — non-fatal
    console.warn("[dates] Migration skipped:", err.message);
  }

  try {
    await sql`
      CREATE INDEX IF NOT EXISTS idx_memories_event_date
      ON memories (event_date_from, event_date_to)
      WHERE deleted_at IS NULL AND event_date_from IS NOT NULL
    `;
    console.log("[dates] Event date index ready");
  } catch (err: any) {
    // Index may already exist — non-fatal
    console.warn("[dates] Index creation skipped:", err.message);
  }
}
