import postgres from "postgres";

const databaseUrl =
  process.env.DATABASE_URL || "postgres://localhost:5432/central_intelligence";

const poolSize = parseInt(process.env.DB_POOL_SIZE || "50");

export const sql = postgres(databaseUrl, {
  max: poolSize,
  idle_timeout: 20,
  connect_timeout: 10,
});

/**
 * Fly Postgres repmgr periodically sets default_transaction_read_only=on.
 * Call this after the server starts to override it, then keep it overridden.
 */
export function ensureWritable() {
  const fix = () => sql`SET default_transaction_read_only = off`.catch(() => {});
  fix();
  setInterval(fix, 30_000);
}

/**
 * Set HNSW ef_search globally so vector queries explore enough candidates.
 * Default pgvector ef_search=40 silently caps results to ~40 even with LIMIT 200.
 * 400 ensures we can return the full 200 candidates for RRF fusion.
 */
export function configureHnswSearch() {
  sql`SET hnsw.ef_search = 400`.catch(() => {});
}
