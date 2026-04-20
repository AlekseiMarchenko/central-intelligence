import { join } from "path";
import { homedir } from "os";
import { existsSync, readFileSync } from "fs";

const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

type EditorSpec = {
  name: string;
  configPath: string;
  // Some tools use `mcpServers`, VS Code uses `servers`
  mcpKey: "mcpServers" | "servers";
};

const EDITORS: EditorSpec[] = [
  { name: "claude-code", configPath: join(homedir(), ".claude", "settings.json"),                         mcpKey: "mcpServers" },
  { name: "cursor",      configPath: join(homedir(), ".cursor", "mcp.json"),                              mcpKey: "mcpServers" },
  { name: "windsurf",    configPath: join(homedir(), ".codeium", "windsurf", "mcp_config.json"),          mcpKey: "mcpServers" },
  { name: "vscode",      configPath: join(homedir(), "Library", "Application Support", "Code", "User", "mcp.json"), mcpKey: "servers" },
];

type Result =
  | { name: string; path: string; status: "configured";    keyPreview: string | null }
  | { name: string; path: string; status: "present-no-ci" }
  | { name: string; path: string; status: "invalid-json";   err: string }
  | { name: string; path: string; status: "not-installed" };

function probe(ed: EditorSpec): Result {
  if (!existsSync(ed.configPath)) {
    return { name: ed.name, path: ed.configPath, status: "not-installed" };
  }
  try {
    const raw = readFileSync(ed.configPath, "utf-8");
    const cfg = JSON.parse(raw);
    const servers = cfg?.[ed.mcpKey];
    const entry = servers && typeof servers === "object" ? servers["central-intelligence"] : undefined;
    if (entry) {
      const key = entry?.env?.CI_API_KEY;
      const preview = typeof key === "string" && key.length > 6 ? `${key.slice(0, 12)}…` : null;
      return { name: ed.name, path: ed.configPath, status: "configured", keyPreview: preview };
    }
    return { name: ed.name, path: ed.configPath, status: "present-no-ci" };
  } catch (err: any) {
    return { name: ed.name, path: ed.configPath, status: "invalid-json", err: err?.message || String(err) };
  }
}

export async function whichEditorsCommand(): Promise<void> {
  console.log("");
  console.log(`${BOLD}ci which-editors${RESET} ${DIM}— which editors have Central Intelligence in their MCP config${RESET}`);
  console.log("");

  const results = EDITORS.map(probe);
  const nameWidth = Math.max(...results.map((r) => r.name.length));
  let configured = 0;
  let missing = 0;

  for (const r of results) {
    const name = r.name.padEnd(nameWidth, " ");
    if (r.status === "configured") {
      configured++;
      const keyHint = r.keyPreview ? ` ${DIM}· ${r.keyPreview} (cloud)${RESET}` : ` ${DIM}· no CI_API_KEY (local mode)${RESET}`;
      console.log(`  ${GREEN}✓${RESET} ${name}  ${DIM}${r.path}${RESET}${keyHint}`);
    } else if (r.status === "present-no-ci") {
      console.log(`  ${YELLOW}⚠${RESET} ${name}  ${DIM}${r.path}${RESET} ${YELLOW}· CI not configured${RESET}`);
    } else if (r.status === "invalid-json") {
      console.log(`  ${YELLOW}⚠${RESET} ${name}  ${DIM}${r.path}${RESET} ${YELLOW}· invalid JSON: ${r.err}${RESET}`);
    } else {
      missing++;
      console.log(`  ${DIM}○${RESET} ${name}  ${DIM}not installed${RESET}`);
    }
  }

  console.log("");
  const plural = configured === 1 ? "" : "s";
  if (configured > 0) {
    console.log(`${BOLD}${configured} editor${plural} configured.${RESET} ${DIM}Restart ${configured === 1 ? "it" : "them"} once to activate memory tools.${RESET}`);
  } else {
    console.log(`${YELLOW}No editors configured yet.${RESET} ${DIM}Run ${RESET}${BOLD}ci signup${RESET} ${DIM}to auto-configure, or add CI manually under "mcpServers" in your editor's config.${RESET}`);
  }
  console.log("");
}
