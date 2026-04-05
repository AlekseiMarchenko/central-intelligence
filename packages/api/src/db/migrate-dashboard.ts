import { sql } from "./connection.js";

export async function migrateDashboard() {
  console.log("[migrate] Adding dashboard support...");

  try {
    // Add email column to api_keys
    await sql`ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS email TEXT`;
    console.log("[migrate] Ensured email column exists on api_keys");

    // Unique index on email (partial — only non-null)
    try {
      await sql`CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_api_keys_email ON api_keys (email) WHERE email IS NOT NULL AND revoked_at IS NULL`;
      console.log("[migrate] Created unique index on api_keys.email");
    } catch (err: any) {
      if (err.message?.includes("already exists")) {
        console.log("[migrate] Email index already exists, skipping");
      } else {
        console.warn("[migrate] Email index creation failed (non-fatal):", err.message);
      }
    }

    // Magic links table
    await sql`
      CREATE TABLE IF NOT EXISTS magic_links (
        id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        api_key_id UUID REFERENCES api_keys(id) ON DELETE CASCADE,
        email      TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        expires_at TIMESTAMPTZ NOT NULL,
        used_at    TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `;
    console.log("[migrate] Ensured magic_links table exists");

    // Dashboard sessions table
    await sql`
      CREATE TABLE IF NOT EXISTS dashboard_sessions (
        id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        api_key_id   UUID NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
        session_hash TEXT NOT NULL UNIQUE,
        expires_at   TIMESTAMPTZ NOT NULL,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `;
    console.log("[migrate] Ensured dashboard_sessions table exists");

    // Index for session cleanup
    try {
      await sql`CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_dashboard_sessions_expires ON dashboard_sessions (expires_at)`;
    } catch {
      // Non-fatal
    }

    // Index for magic link cleanup
    try {
      await sql`CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_magic_links_expires ON magic_links (expires_at)`;
    } catch {
      // Non-fatal
    }

    // Add raw_key column to magic_links (for new signup key reveal)
    await sql`ALTER TABLE magic_links ADD COLUMN IF NOT EXISTS raw_key TEXT`;
    console.log("[migrate] Ensured raw_key column exists on magic_links");

    console.log("[migrate] Dashboard migration complete");
  } catch (err: any) {
    console.warn("[migrate] Dashboard migration failed (non-fatal):", err.message);
  }
}

// Run directly if called as script
if (process.argv[1]?.endsWith("migrate-dashboard.ts") || process.argv[1]?.endsWith("migrate-dashboard.js")) {
  migrateDashboard()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
