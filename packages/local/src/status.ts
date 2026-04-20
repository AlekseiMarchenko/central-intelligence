import { join } from "path";
import { homedir } from "os";
import { existsSync, statSync } from "fs";
import { getDb, getMemoryCount } from "./db.js";
import { detectMode, apiCall, maskKey } from "./cloud.js";

const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";

const DB_PATH = join(homedir(), ".central-intelligence", "memories.db");
const PKG_VERSION = "1.3.4";

function pad(label: string, width = 14): string {
  return label.padEnd(width, " ");
}

type UsageResponse = {
  memories: { total: number; by_scope: Record<string, number> };
  active_agents?: string[];
};

export async function statusCommand(): Promise<void> {
  const mode = detectMode();
  console.log("");
  console.log(`${BOLD}Central Intelligence${RESET} ${DIM}· v${PKG_VERSION}${RESET}`);
  console.log("");

  if (mode.kind === "cloud") {
    // --- Cloud mode: query the API for real memory state ---
    console.log(`${DIM}${pad("Mode:")}${RESET}${GREEN}cloud${RESET} ${DIM}(synced via API key ${maskKey(mode.apiKey)})${RESET}`);
    console.log(`${DIM}${pad("Dashboard:")}${RESET}https://centralintelligence.online/dashboard`);
    console.log(`${DIM}${pad("API:")}${RESET}${DIM}${mode.apiUrl}${RESET}`);

    try {
      const data = (await apiCall(mode, "/usage")) as UsageResponse;
      const total = data?.memories?.total ?? 0;
      const plural = total === 1 ? "" : "s";
      const byScope = data?.memories?.by_scope || {};
      const scopeParts = Object.entries(byScope)
        .map(([scope, count]) => `${scope}=${count}`)
        .join(" ");
      const scopeHint = scopeParts ? ` ${DIM}(${scopeParts})${RESET}` : "";
      console.log(`${DIM}${pad("Memories:")}${RESET}${total} stored${plural === "" ? "" : ""}${scopeHint}`);
      const agents = data?.active_agents?.length ?? 0;
      console.log(`${DIM}${pad("Agents:")}${RESET}${agents} active ${DIM}(last 30 days)${RESET}`);
      console.log(`${DIM}${pad("MCP server:")}${RESET}${GREEN}configured${RESET} ${DIM}(editors call central-intelligence-mcp on-demand)${RESET}`);
    } catch (err: any) {
      console.log(`${DIM}${pad("Memories:")}${RESET}${RED}error${RESET} ${DIM}${err.message}${RESET}`);
      console.log(`${DIM}${pad("MCP server:")}${RESET}${YELLOW}API unreachable — check network + that your API key is still valid${RESET}`);
    }

    console.log("");
    console.log(`${DIM}Next:${RESET}`);
    console.log(`  ${DIM}·${RESET} ${BOLD}ci test-memory${RESET}   ${DIM}round-trip a test memory through the cloud${RESET}`);
    console.log(`  ${DIM}·${RESET} ${BOLD}ci which-editors${RESET} ${DIM}see which editors have CI in their MCP config${RESET}`);
    console.log("");
    return;
  }

  // --- Local mode ---
  console.log(`${DIM}${pad("Mode:")}${RESET}${CYAN}local${RESET} ${DIM}(SQLite on this machine, no signup)${RESET}`);
  console.log(`${DIM}${pad("Dashboard:")}${RESET}http://localhost:3141`);

  let memCount = 0;
  let dbExists = existsSync(DB_PATH);
  if (dbExists) {
    try {
      getDb();
      memCount = getMemoryCount();
    } catch (err: any) {
      console.log(`${DIM}${pad("Memories:")}${RESET}${YELLOW}error reading DB: ${err.message}${RESET}`);
      dbExists = false;
    }
  }
  if (dbExists) {
    console.log(`${DIM}${pad("Memories:")}${RESET}${memCount} stored`);
    try {
      const stat = statSync(DB_PATH);
      const kb = (stat.size / 1024).toFixed(1);
      console.log(`${DIM}${pad("DB:")}${RESET}${DIM}${DB_PATH} (${kb} KB)${RESET}`);
    } catch {
      console.log(`${DIM}${pad("DB:")}${RESET}${DIM}${DB_PATH}${RESET}`);
    }
  } else {
    console.log(`${DIM}${pad("Memories:")}${RESET}${DIM}no DB yet (run 'ci' once to initialize)${RESET}`);
  }
  console.log(`${DIM}${pad("MCP server:")}${RESET}${GREEN}ready${RESET} ${DIM}(run 'ci' with no args to start)${RESET}`);

  console.log("");
  console.log(`${DIM}Next:${RESET}`);
  console.log(`  ${DIM}·${RESET} ${BOLD}ci test-memory${RESET}   ${DIM}round-trip a test memory through remember/recall${RESET}`);
  console.log(`  ${DIM}·${RESET} ${BOLD}ci which-editors${RESET} ${DIM}see which editors have CI in their MCP config${RESET}`);
  console.log(`  ${DIM}·${RESET} ${BOLD}ci signup${RESET}        ${DIM}enable cloud sync (free API key)${RESET}`);
  console.log("");
}
