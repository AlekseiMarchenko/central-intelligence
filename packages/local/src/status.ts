import { join } from "path";
import { homedir } from "os";
import { existsSync, readFileSync, statSync } from "fs";
import { getDb, getMemoryCount } from "./db.js";

const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";

const CONFIG_DIR = join(homedir(), ".central-intelligence");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");
const DB_PATH = join(CONFIG_DIR, "memories.db");
const PKG_VERSION = "1.3.3"; // bumped in lockstep with package.json

function pad(label: string, width = 14): string {
  return label.padEnd(width, " ");
}

export async function statusCommand(): Promise<void> {
  console.log("");
  console.log(`${BOLD}Central Intelligence Local${RESET} ${DIM}· v${PKG_VERSION}${RESET}`);
  console.log("");

  // --- Mode: cloud if config.api_key exists, else local ---
  let mode: "cloud" | "local" = "local";
  let apiKeyPreview: string | null = null;
  if (existsSync(CONFIG_PATH)) {
    try {
      const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
      if (typeof cfg.api_key === "string" && cfg.api_key.length > 0) {
        mode = "cloud";
        apiKeyPreview = `${cfg.api_key.slice(0, 12)}…`;
      }
    } catch {
      // malformed config — treat as local
    }
  }
  const modeStr = mode === "cloud"
    ? `${GREEN}cloud${RESET} ${DIM}(synced via API key ${apiKeyPreview})${RESET}`
    : `${CYAN}local${RESET} ${DIM}(SQLite on this machine, no signup)${RESET}`;
  console.log(`${DIM}${pad("Mode:")}${RESET}${modeStr}`);

  // --- Dashboard URL ---
  const dashUrl = mode === "cloud"
    ? "https://centralintelligence.online/dashboard"
    : "http://localhost:3141";
  console.log(`${DIM}${pad("Dashboard:")}${RESET}${dashUrl}`);

  // --- Memories stored ---
  let memCount = 0;
  let dbExists = existsSync(DB_PATH);
  if (dbExists) {
    try {
      // Touch the DB to ensure schema exists (getDb initializes tables)
      getDb();
      memCount = getMemoryCount();
    } catch (err: any) {
      console.log(`${DIM}${pad("Memories:")}${RESET}${YELLOW}error reading DB: ${err.message}${RESET}`);
      dbExists = false;
    }
  }
  if (dbExists) {
    const plural = memCount === 1 ? "" : "s";
    console.log(`${DIM}${pad("Memories:")}${RESET}${memCount} stored${plural === "" ? "" : ""}`);
  } else {
    console.log(`${DIM}${pad("Memories:")}${RESET}${DIM}no DB yet (run 'ci' once to initialize)${RESET}`);
  }

  // --- DB path + size ---
  if (dbExists) {
    try {
      const stat = statSync(DB_PATH);
      const kb = (stat.size / 1024).toFixed(1);
      console.log(`${DIM}${pad("DB:")}${RESET}${DIM}${DB_PATH} (${kb} KB)${RESET}`);
    } catch {
      console.log(`${DIM}${pad("DB:")}${RESET}${DIM}${DB_PATH}${RESET}`);
    }
  }

  // --- MCP server hint: this command runs as a subcommand; by definition the server
  // is NOT running in THIS process. We report whether the CLI *would* run, and how
  // to launch it. Checking a live MCP stdio server from another process is unreliable
  // (no PID file, no port), so we report readiness instead of liveness. ---
  console.log(`${DIM}${pad("MCP server:")}${RESET}${GREEN}ready${RESET} ${DIM}(run 'ci' with no args to start)${RESET}`);

  console.log("");
  console.log(`${DIM}Next:${RESET}`);
  console.log(`  ${DIM}·${RESET} ${BOLD}ci test-memory${RESET}   ${DIM}round-trip a test memory through remember/recall${RESET}`);
  console.log(`  ${DIM}·${RESET} ${BOLD}ci which-editors${RESET} ${DIM}see which editors have CI in their MCP config${RESET}`);
  if (mode === "local") {
    console.log(`  ${DIM}·${RESET} ${BOLD}ci signup${RESET}        ${DIM}enable cloud sync (free API key)${RESET}`);
  }
  console.log("");
}
