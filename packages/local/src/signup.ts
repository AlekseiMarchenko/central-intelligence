import { join } from "path";
import { homedir } from "os";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";

const API_URL = "https://central-intelligence-api.fly.dev";
const CONFIG_DIR = join(homedir(), ".central-intelligence");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

// --- Pretty output ---
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

function log(msg: string) { console.log(msg); }
function success(msg: string) { console.log(`  ${GREEN}✓${RESET} ${msg}`); }
function skip(msg: string) { console.log(`  ${DIM}- ${msg}${RESET}`); }

// --- MCP tool configuration (reused from sync.ts) ---
const TOOL_CONFIGS = [
  { name: "Claude Code", dir: join(homedir(), ".claude"), path: join(homedir(), ".claude", "settings.json") },
  { name: "Cursor", dir: join(homedir(), ".cursor"), path: join(homedir(), ".cursor", "mcp.json") },
  { name: "Windsurf", dir: join(homedir(), ".codeium", "windsurf"), path: join(homedir(), ".codeium", "windsurf", "mcp_config.json") },
];

function configureMcpTools(apiKey: string): number {
  const mcpEntry = {
    command: "npx",
    args: ["central-intelligence-mcp"],
    env: { CI_API_KEY: apiKey },
  };
  let configured = 0;
  for (const tool of TOOL_CONFIGS) {
    if (!existsSync(tool.dir)) { skip(`${tool.name} not detected`); continue; }
    try {
      let config: any = {};
      if (existsSync(tool.path)) { config = JSON.parse(readFileSync(tool.path, "utf-8")); }
      if (!config.mcpServers) config.mcpServers = {};
      const existing = config.mcpServers["central-intelligence"];
      if (existing?.env?.CI_API_KEY === apiKey) { success(`${tool.name} already configured`); configured++; continue; }
      config.mcpServers["central-intelligence"] = mcpEntry;
      mkdirSync(join(tool.path, ".."), { recursive: true });
      writeFileSync(tool.path, JSON.stringify(config, null, 2) + "\n", "utf-8");
      success(`${tool.name} configured → ${tool.path}`);
      configured++;
    } catch (err: any) { skip(`${tool.name}: ${err.message}`); }
  }
  return configured;
}

function saveConfig(apiKey: string) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  let config: Record<string, unknown> = {};
  try { config = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")); } catch {}
  config.api_key = apiKey;
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

function getExistingKey(): string | null {
  try {
    const config = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    return config.api_key || null;
  } catch { return null; }
}

export async function signupCommand(): Promise<void> {
  log("");
  log(`${BOLD}Central Intelligence — Signup${RESET}`);
  log("");

  // Check if already signed up
  const existingKey = getExistingKey();
  if (existingKey) {
    log(`  You already have an API key: ${DIM}${existingKey.slice(0, 16)}...${RESET}`);
    log(`  Saved at: ${DIM}${CONFIG_PATH}${RESET}`);
    log("");
    log(`  To reconfigure your tools, run: ${GREEN}ci sync --key ${existingKey}${RESET}`);
    log(`  To get a new key, delete ${CONFIG_PATH} and run signup again.`);
    log("");
    return;
  }

  // Create API key via the public /keys endpoint (no auth needed)
  log(`${DIM}Creating your API key...${RESET}`);

  try {
    const res = await fetch(`${API_URL}/keys`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "cli-signup" }),
    });

    if (!res.ok) {
      const err = await res.text();
      log(`${YELLOW}Signup failed: ${err}${RESET}`);
      process.exit(1);
    }

    const data = await res.json() as { key: string; id: string };
    const apiKey = data.key;

    // Save locally
    saveConfig(apiKey);
    log("");
    success(`API key created: ${GREEN}${apiKey}${RESET}`);
    log(`  ${DIM}Saved to ${CONFIG_PATH}${RESET}`);

    // Configure AI tools
    log("");
    log(`${DIM}Configuring AI tools...${RESET}`);
    const configured = configureMcpTools(apiKey);

    // Summary
    log("");
    if (configured > 0) {
      log(`${GREEN}${BOLD}Done!${RESET} ${configured} tool(s) configured. Restart them to activate memory.`);
    } else {
      log(`${BOLD}API key ready.${RESET} No AI tools detected to auto-configure.`);
      log(`  Add this to your tool's MCP config:`);
      log(`  ${DIM}CI_API_KEY=${apiKey}${RESET}`);
    }

    log("");
    log(`  ${DIM}View your memories: ${RESET}https://centralintelligence.online/app`);
    log(`  ${DIM}Sync local memories: ${RESET}ci sync --key ${apiKey}`);
    log(`  ${DIM}Open local dashboard: ${RESET}ci dashboard`);
    log("");
  } catch (err: any) {
    log(`${YELLOW}Could not reach the CI API. Check your internet connection.${RESET}`);
    log(`${DIM}${err.message}${RESET}`);
    process.exit(1);
  }
}
