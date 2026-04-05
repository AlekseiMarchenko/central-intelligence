import { join } from "path";
import { homedir } from "os";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";

const API_URL = "https://central-intelligence-api.fly.dev";

// --- Pretty output ---
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

function log(msg: string) { console.log(msg); }
function success(msg: string) { console.log(`  ${GREEN}✓${RESET} ${msg}`); }
function skip(msg: string) { console.log(`  ${DIM}- ${msg}${RESET}`); }
function warn(msg: string) { console.log(`  ${YELLOW}!${RESET} ${msg}`); }

// --- MCP tool configuration ---
const TOOL_CONFIGS = [
  {
    name: "Claude Code",
    dir: join(homedir(), ".claude"),
    path: join(homedir(), ".claude", "settings.json"),
  },
  {
    name: "Cursor",
    dir: join(homedir(), ".cursor"),
    path: join(homedir(), ".cursor", "mcp.json"),
  },
  {
    name: "Windsurf",
    dir: join(homedir(), ".codeium", "windsurf"),
    path: join(homedir(), ".codeium", "windsurf", "mcp_config.json"),
  },
];

function configureMcpTools(apiKey: string): number {
  const mcpEntry = {
    command: "npx",
    args: ["central-intelligence-mcp"],
    env: { CI_API_KEY: apiKey },
  };

  let configured = 0;

  for (const tool of TOOL_CONFIGS) {
    // Check if the tool's directory exists (means the tool is installed)
    if (!existsSync(tool.dir)) {
      skip(`${tool.name} not detected`);
      continue;
    }

    try {
      let config: any = {};

      if (existsSync(tool.path)) {
        // Read existing config
        const raw = readFileSync(tool.path, "utf-8");
        config = JSON.parse(raw);
      }

      // Ensure mcpServers key exists
      if (!config.mcpServers) {
        config.mcpServers = {};
      }

      // Check if already configured with same key
      const existing = config.mcpServers["central-intelligence"];
      if (existing?.env?.CI_API_KEY === apiKey) {
        success(`${tool.name} already configured`);
        configured++;
        continue;
      }

      // Add or update the entry
      config.mcpServers["central-intelligence"] = mcpEntry;

      // Write back
      mkdirSync(join(tool.path, ".."), { recursive: true });
      writeFileSync(tool.path, JSON.stringify(config, null, 2) + "\n", "utf-8");
      success(`${tool.name} configured → ${tool.path}`);
      configured++;
    } catch (err: any) {
      warn(`${tool.name}: ${err.message}`);
    }
  }

  return configured;
}

// --- Main sync command ---
export async function syncCommand(): Promise<void> {
  log("");
  log(`${BOLD}Central Intelligence — Sync${RESET}`);
  log("");

  // 1. Parse --key flag or env var
  const keyIdx = process.argv.indexOf("--key");
  const apiKey = keyIdx !== -1 && process.argv[keyIdx + 1]
    ? process.argv[keyIdx + 1]
    : process.env.CI_API_KEY;

  if (!apiKey) {
    log(`${YELLOW}Missing API key.${RESET} Provide it with:`);
    log("");
    log(`  npx central-intelligence-local sync --key YOUR_KEY`);
    log("");
    log(`Get your key at: ${DIM}https://centralintelligence.online/app${RESET}`);
    process.exit(1);
  }

  // 2. Validate the key against the API
  log(`${DIM}Validating API key...${RESET}`);
  try {
    const checkRes = await fetch(`${API_URL}/health`);
    if (!checkRes.ok) {
      warn("Could not reach Central Intelligence API. Check your internet connection.");
      process.exit(1);
    }
  } catch {
    warn("Could not reach Central Intelligence API. Check your internet connection.");
    process.exit(1);
  }

  // 3. Read local memories
  let memories: any[] = [];
  const dbPath = join(homedir(), ".central-intelligence", "memories.db");

  if (existsSync(dbPath)) {
    try {
      const { getAllMemories } = await import("./db.js");
      memories = getAllMemories();
      log(`  Found ${BOLD}${memories.length}${RESET} local memories`);
    } catch {
      log(`  No local memories found`);
    }
  } else {
    log(`  No local database found (first time? That's fine!)`);
  }

  // 4. Upload to cloud
  if (memories.length > 0) {
    log("");
    log(`${DIM}Syncing memories to cloud...${RESET}`);

    let synced = 0;
    let skipped = 0;
    let errors = 0;

    for (const mem of memories) {
      try {
        const tags = (() => {
          try { return JSON.parse(mem.tags || "[]"); }
          catch { return []; }
        })();

        const res = await fetch(`${API_URL}/memories/remember`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            agent_id: mem.agent_id || "synced",
            content: mem.content,
            tags,
            scope: mem.scope || "agent",
          }),
        });

        if (res.ok) {
          synced++;
        } else if (res.status === 401) {
          warn("Invalid API key. Check your key and try again.");
          process.exit(1);
        } else if (res.status === 429) {
          warn("Rate limited. Wait a minute and try again.");
          process.exit(1);
        } else {
          errors++;
        }
      } catch {
        errors++;
      }

      // Progress indicator
      const total = synced + skipped + errors;
      if (total % 10 === 0 || total === memories.length) {
        process.stdout.write(`\r  ${synced}/${memories.length} synced`);
      }
    }

    log(""); // newline after progress
    success(`${synced} memories synced to cloud`);
    if (errors > 0) warn(`${errors} failed (will retry next sync)`);
  }

  // 5. Configure AI tools
  log("");
  log(`${DIM}Configuring AI tools...${RESET}`);
  const configured = configureMcpTools(apiKey);

  // 6. Summary
  log("");
  if (memories.length > 0 || configured > 0) {
    log(`${GREEN}${BOLD}Done!${RESET} ${memories.length > 0 ? `${memories.length} memories synced. ` : ""}${configured > 0 ? `${configured} tool(s) configured.` : ""}`);
    log(`${DIM}Memories will appear on your dashboard within seconds.${RESET}`);
  } else {
    log(`${BOLD}Setup complete.${RESET} Your AI tools are configured.`);
    log(`${DIM}Start a conversation — memories will sync automatically.${RESET}`);
  }

  if (configured > 0) {
    log(`${DIM}Restart your AI tools to activate memory.${RESET}`);
  }

  log("");
}
