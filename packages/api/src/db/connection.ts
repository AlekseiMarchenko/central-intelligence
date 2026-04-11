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
 * Run a vector search query with correct HNSW ef_search.
 *
 * CRITICAL: pgvector default ef_search=40 silently caps HNSW results to ~40
 * even with LIMIT 200. We need 400 for full candidate pools.
 *
 * The naive approach (SET once on startup) only affects ONE connection in
 * the pool. The other 49 connections still use ef_search=40. postgres.js
 * has no onconnect callback to SET on every new connection.
 *
 * This helper wraps each vector query in a transaction that SETs ef_search
 * first, guaranteeing the SET and query run on the same connection.
 * Overhead: ~1ms per vector query (one extra round trip for BEGIN/SET/COMMIT).
 */
export async function withHnswSearch<T>(fn: (tx: any) => Promise<T>): Promise<T> {
  return sql.begin(async (tx: any) => {
    await tx`SET LOCAL hnsw.ef_search = 400`;
    return fn(tx);
  }) as Promise<T>;
}

/**
 * @deprecated Use withHnswSearch() instead. This only sets ef_search on one
 * connection in the pool — the other 49 connections still use the default.
 */
export function configureHnswSearch() {
  sql`SET hnsw.ef_search = 400`.catch(() => {});
}
