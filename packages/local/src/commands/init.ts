import { discoverFiles } from "../file-sources.js";
import { getMemoryCount } from "../db.js";
import { existsSync } from "fs";
import { join } from "path";

const MCP_CONFIGS: Record<string, { configPath: string; snippet: string }> = {
  claude_md: {
    configPath: ".claude/settings.json",
    snippet: `{
  "mcpServers": {
    "central-intelligence": {
      "command": "npx",
      "args": ["central-intelligence-local"]
    }
  }
}`,
  },
  cursor_rules: {
    configPath: ".cursor/mcp.json",
    snippet: `{
  "mcpServers": {
    "central-intelligence": {
      "command": "npx",
      "args": ["central-intelligence-local"]
    }
  }
}`,
  },
  windsurf_rules: {
    configPath: ".windsurf/mcp.json",
    snippet: `{
  "mcpServers": {
    "central-intelligence": {
      "command": "npx",
      "args": ["central-intelligence-local"]
    }
  }
}`,
  },
};

export async function initCommand(): Promise<void> {
  const chalk = (await import("chalk")).default;
  console.log(chalk.bold("\nCI Local Pro — Init\n"));

  // 1. Detect AI tools
  const files = discoverFiles();
  const detectedTools = new Set(files.map((f) => f.source));

  if (files.length === 0) {
    console.log(chalk.yellow("  No AI tool config files found in this directory."));
    console.log(chalk.dim("  Supported: CLAUDE.md, .cursor/rules, .windsurf/rules, codex.md, .github/copilot-instructions.md"));
    console.log();
  } else {
    console.log(chalk.bold("Detected AI tools:"));
    for (const f of files) {
      const entryCount = "—"; // Would count entries if we parsed
      console.log(`  ${chalk.green("✓")} ${f.source} → ${f.path} (${Math.round(f.size / 1024)}KB)`);
    }
    console.log();
  }

  // 2. Check DB
  let memCount = 0;
  try {
    memCount = getMemoryCount();
  } catch {
    // DB doesn't exist yet
  }

  console.log(chalk.bold("Memory status:"));
  console.log(`  Database: ${memCount} memories in ~/.central-intelligence/memories.db`);
  console.log(`  Files:    ${files.length} config file(s) detected`);
  console.log();

  // 3. Check MCP configuration for each detected tool
  console.log(chalk.bold("MCP server configuration:"));
  let allConfigured = true;

  for (const [source, config] of Object.entries(MCP_CONFIGS)) {
    if (!detectedTools.has(source as any)) continue;

    const configExists = existsSync(join(process.cwd(), config.configPath));
    if (configExists) {
      console.log(`  ${chalk.green("✓")} ${source}: MCP config found at ${config.configPath}`);
    } else {
      allConfigured = false;
      console.log(`  ${chalk.yellow("✗")} ${source}: No MCP config. Add this to ${config.configPath}:`);
      console.log(chalk.dim(config.snippet.split("\n").map((l) => "    " + l).join("\n")));
      console.log();
    }
  }

  if (allConfigured && files.length > 0) {
    console.log(chalk.green("\n  All detected tools have CI Local configured. Ready to go.\n"));
  }

  // Summary
  const totalEntries = memCount + files.reduce((sum, f) => sum + Math.round(f.size / 100), 0); // rough estimate
  console.log(
    chalk.bold("Summary: ") +
    `${files.length} tool(s), ${memCount} DB memories. CI Local ${memCount > 0 ? "active" : "ready to start"}.`
  );
  console.log();
}
