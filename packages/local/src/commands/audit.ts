import { parseAllFiles } from "../file-sources.js";
import { getAllMemories } from "../db.js";
import { computeHealth } from "../health.js";
import { detectDuplicates, computeFreshness } from "../analysis.js";

interface AuditOptions {
  verbose?: boolean;
  json?: boolean;
}

export async function auditCommand(options: AuditOptions): Promise<void> {
  const chalk = (await import("chalk")).default;
  console.log(chalk.bold("\nCI Local Pro — Memory Audit\n"));

  // 1. Parse all file sources
  const { entries: fileEntries, files, warnings } = parseAllFiles();

  // 2. Load DB memories
  let dbMemories: ReturnType<typeof getAllMemories> = [];
  try {
    dbMemories = getAllMemories();
  } catch {
    dbMemories = [];
    console.log(chalk.yellow("  No CI Local database found. Run the MCP server first to create one.\n"));
  }

  // 3. Show warnings
  for (const w of warnings) {
    console.log(chalk.yellow(`  Warning: ${w}`));
  }

  // 4. Source breakdown
  console.log(chalk.bold("Sources:"));
  console.log(`  ${chalk.cyan("Database:")}     ${dbMemories.length} memories`);
  for (const f of files) {
    const count = fileEntries.filter((e) => e.source_path === f.path).length;
    console.log(
      `  ${chalk.cyan(f.source + ":")} ${count} entries (${f.path})`
    );
  }
  if (files.length === 0) {
    console.log(chalk.dim("  No AI tool config files found in this directory."));
  }
  console.log();

  // 5. Freshness analysis
  const allWithFreshness = [
    ...dbMemories.map((m) => ({
      id: m.id,
      content: m.content,
      source: "db" as const,
      freshness_score: computeFreshness(m.created_at),
      duplicate_group: null as string | null,
      created_at: m.created_at,
    })),
    ...fileEntries.map((e) => ({
      id: e.content_hash,
      content: e.content,
      source: e.source,
      freshness_score: 1.0, // File entries: freshness from cache (TODO: use first_seen from DB)
      duplicate_group: null as string | null,
      created_at: new Date().toISOString(),
    })),
  ];

  // 6. Duplicate detection
  const withDuplicates = detectDuplicates(allWithFreshness);

  // 7. Health score
  const health = computeHealth(withDuplicates, fileEntries);

  // 8. Display
  const scoreColor =
    health.score >= 8 ? chalk.green : health.score >= 5 ? chalk.yellow : chalk.red;

  console.log(chalk.bold("Health Score: ") + scoreColor(`${health.score}/10`));
  console.log();

  for (const issue of health.issues) {
    const icon = issue.includes("healthy") ? chalk.green("✓") : chalk.yellow("!");
    console.log(`  ${icon} ${issue}`);
  }

  console.log();
  console.log(chalk.dim("Stats:"));
  console.log(`  Total:      ${health.stats.total_memories}`);
  console.log(`  Database:   ${health.stats.db_memories}`);
  console.log(`  From files: ${health.stats.file_entries}`);
  console.log(`  Stale:      ${health.stats.stale_count}`);
  console.log(`  Dup groups: ${health.stats.duplicate_groups}`);
  console.log(`  Platforms:  ${health.stats.sources_detected}`);

  if (options.verbose) {
    console.log();
    console.log(chalk.bold("All entries:"));
    for (const m of withDuplicates) {
      const fresh = m.freshness_score >= 0.7 ? chalk.green("fresh") : m.freshness_score >= 0.3 ? chalk.yellow("aging") : chalk.red("stale");
      const dup = m.duplicate_group ? chalk.red(` [dup:${m.duplicate_group.slice(0, 6)}]`) : "";
      const preview = m.content.slice(0, 80).replace(/\n/g, " ");
      console.log(`  ${chalk.dim(m.source)} ${fresh}${dup} ${preview}`);
    }
  }

  if (options.json) {
    console.log(JSON.stringify({ health, entries: withDuplicates }, null, 2));
  }

  console.log();
}
