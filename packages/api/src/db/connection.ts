import postgres from "postgres";

const databaseUrl =
  process.env.DATABASE_URL || "postgres://localhost:5432/central_intelligence";

export const sql = postgres(databaseUrl, {
  max: 20,
  idle_timeout: 20,
  connect_timeout: 10,
});
