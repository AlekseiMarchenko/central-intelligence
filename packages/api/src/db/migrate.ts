import postgres from "postgres";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const databaseUrl =
  process.env.DATABASE_URL || "postgres://localhost:5432/central_intelligence";

async function migrate() {
  const sql = postgres(databaseUrl);

  console.log("Running migrations...");

  const schema = readFileSync(join(__dirname, "schema.sql"), "utf-8");
  await sql.unsafe(schema);

  console.log("Migrations complete.");
  await sql.end();
}

migrate().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
