import { readFileSync, writeFileSync } from "fs";
import { parseAllFiles } from "../file-sources.js";
import { getAllMemories } from "../db.js";

interface ExportBundle {
  version: "1.0";
  exported_at: string;
  sources: {
    db: { count: number; memories: ExportedMemory[] };
    files: { count: number; entries: ExportedFileEntry[]; paths: string[] };
  };
}

interface ExportedMemory {
  id: string;
  agent_id: string;
  content: string;
  scope: string;
  tags: string;
  created_at: string;
}

interface ExportedFileEntry {
  content_hash: string;
  source: string;
  source_path: string;
  section_title: string | null;
  content: string;
}

interface ExportOptions {
  output?: string;
}

export async function exportCommand(options: ExportOptions): Promise<void> {
  const chalk = (await import("chalk")).default;
  // Load all sources
  let dbMemories: ReturnType<typeof getAllMemories> = [];
  try {
    dbMemories = getAllMemories();
  } catch {
    dbMemories = [];
  }
  const { entries: fileEntries, files } = parseAllFiles();

  const bundle: ExportBundle = {
    version: "1.0",
    exported_at: new Date().toISOString(),
    sources: {
      db: {
        count: dbMemories.length,
        memories: dbMemories.map((m) => ({
          id: m.id,
          agent_id: m.agent_id,
          content: m.content,
          scope: m.scope,
          tags: m.tags,
          created_at: m.created_at,
        })),
      },
      files: {
        count: fileEntries.length,
        entries: fileEntries.map((e) => ({
          content_hash: e.content_hash,
          source: e.source,
          source_path: e.source_path,
          section_title: e.section_title,
          content: e.content,
        })),
        paths: files.map((f) => f.path),
      },
    },
  };

  const json = JSON.stringify(bundle, null, 2);

  if (options.output) {
    writeFileSync(options.output, json, "utf-8");
    console.log(
      chalk.green(
        `Exported ${dbMemories.length} DB memories + ${fileEntries.length} file entries → ${options.output}`
      )
    );
  } else {
    process.stdout.write(json);
  }
}

export async function importCommand(file: string): Promise<void> {
  const chalk = (await import("chalk")).default;
  // Validate file
  let raw: string;
  try {
    raw = readFileSync(file, "utf-8");
  } catch (err: any) {
    console.error(chalk.red(`Cannot read file: ${err.message}`));
    process.exit(1);
  }

  // Size check
  if (raw.length > 50 * 1024 * 1024) {
    console.error(chalk.red("File exceeds 50MB limit. Refusing to import."));
    process.exit(1);
  }

  let bundle: ExportBundle;
  try {
    bundle = JSON.parse(raw);
  } catch {
    console.error(chalk.red("Invalid JSON. Cannot parse import file."));
    process.exit(1);
  }

  if (bundle.version !== "1.0") {
    console.error(
      chalk.red(`Unsupported version: ${bundle.version}. Expected 1.0.`)
    );
    process.exit(1);
  }

  const dbMemories = bundle.sources?.db?.memories || [];
  const fileEntries = bundle.sources?.files?.entries || [];

  // Import DB memories (skip duplicates by content similarity)
  let imported = 0;
  let skipped = 0;

  // For now, use exact content match for collision detection.
  // Embedding-based collision (cosine > 0.95) would require loading the model.
  // Exact match is a reasonable first pass.
  let existingContents: Set<string>;
  try {
    const existing = getAllMemories();
    existingContents = new Set(existing.map((m) => m.content));
  } catch {
    existingContents = new Set();
  }

  // We don't insert into the DB directly from the CLI to avoid conflicts
  // with the running MCP server. Instead, we report what would be imported.
  for (const mem of dbMemories) {
    if (existingContents.has(mem.content)) {
      skipped++;
    } else {
      imported++;
    }
  }

  console.log(chalk.bold("\nCI Local Pro — Import\n"));
  console.log(`  DB memories: ${imported} new, ${skipped} skipped (already exist)`);
  console.log(`  File entries: ${fileEntries.length} noted (informational only)`);

  if (imported > 0) {
    console.log(
      chalk.yellow(
        `\n  Note: To actually insert ${imported} memories, use the CI Local MCP server's 'remember' tool.`
      )
    );
    console.log(
      chalk.dim(
        "  Direct DB insertion is deferred to avoid conflicts with a running MCP server."
      )
    );
  }

  console.log();
}
