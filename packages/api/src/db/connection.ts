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
