#!/usr/bin/env node

import { Command } from "commander";
import { auditCommand } from "./commands/audit.js";
import { initCommand } from "./commands/init.js";
import { exportCommand, importCommand } from "./commands/transfer.js";
import { testCommand } from "./commands/test.js";
import { dashboardCommand } from "./commands/dashboard.js";
import { chatgptImportCommand } from "./commands/chatgpt-import.js";
import { chatgptInitCommand } from "./commands/chatgpt-init.js";
import { syncCommand } from "./sync.js";

const program = new Command();

program
  .name("ci")
  .description(
    "Central Intelligence — cross-tool memory management, dashboard, and sync"
  )
  .version("1.2.0");

program
  .command("audit")
  .description("Show all memory sources, duplicates, staleness, and health score")
  .option("--verbose", "Show detailed output for each memory entry")
  .option("--json", "Output as JSON")
  .action(auditCommand);

program
  .command("init")
  .description("Detect AI tools and set up CI Local")
  .action(initCommand);

program
  .command("sync")
  .description("Sync local memories to cloud and configure AI tools")
  .option("--key <key>", "API key (or set CI_API_KEY env var)")
  .action((opts) => {
    // Pass key to argv so syncCommand can read it
    if (opts.key) {
      const idx = process.argv.indexOf("--key");
      if (idx === -1) {
        process.argv.push("--key", opts.key);
      }
    }
    syncCommand();
  });

program
  .command("test")
  .description("Run Agent Memory Benchmark against your local memory")
  .action(testCommand);

program
  .command("export")
  .description("Export all memories to a portable JSON bundle")
  .option("-o, --output <file>", "Output file (default: stdout)")
  .action(exportCommand);

program
  .command("import")
  .description("Import memories from a JSON bundle")
  .argument("<file>", "JSON file to import")
  .action(importCommand);

program
  .command("dashboard")
  .description("Open local web dashboard to visualize and manage memories")
  .option("-p, --port <port>", "Port number", "3141")
  .action(dashboardCommand);

program
  .command("chatgpt-init")
  .description("Save your ChatGPT custom instructions as a local file for cross-tool memory")
  .action(chatgptInitCommand);

program
  .command("chatgpt-import")
  .description("Import memories from a ChatGPT data export (conversations.json)")
  .argument("<file>", "Path to conversations.json from ChatGPT export")
  .option("--dry-run", "Show what would be imported without storing anything")
  .option("--limit <n>", "Max memories to import", "50")
  .option("--all", "Skip conversation picker, import everything")
  .action(chatgptImportCommand);

program.parse();
