import { getDb, store } from "../src/db.js";
import { embed } from "../src/embeddings.js";

const PROJECT = "Central Intelligence Development";

const memories = [
  // Project state
  "Central Intelligence v0.5.0 is a cross-tool memory layer for AI agents. Memories stored in one tool are available in all others.",
  "CI uses open-core licensing: MCP server and file reading are open-source (Apache 2.0), CLI tools (dashboard, audit, health) are closed-source in ci-local-pro repo.",
  "CI Local reads config files from 6 AI platforms: CLAUDE.md, .cursor/rules, .windsurf/rules, codex.md, .github/copilot-instructions.md, .chatgpt/instructions.md.",
  "The competitive moat is cross-tool memory portability. No platform vendor will build this because they want lock-in. Hindsight by Vectorize is the closest competitor.",
  "CI pivoted from Mem0 replacement positioning to cross-tool memory layer after CEO review revealed the real competitor is a text file (CLAUDE.md), not Mem0.",

  // Architecture
  "CI Local uses SQLite with WAL mode, FTS5 for full-text search, and Xenova/all-MiniLM-L6-v2 for local embeddings. No cloud dependency.",
  "CI Local hybrid search uses 3 strategies: vector similarity, FTS5 full-text, and fuzzy substring matching, fused via Reciprocal Rank Fusion with temporal decay.",
  "File source cache table stores content hashes and embeddings so config files are only re-embedded when content changes. First run is slow, subsequent runs are instant.",
  "ci-local-pro dashboard runs at localhost:3141 with semantic search, project tag filtering, checkboxes for bulk delete, and memory health scoring.",

  // User preferences
  "Prefer ideation before building. Discuss the user problem and approach before writing code. The CEO review format works well for this.",
  "Prefer closed-source for competitive features and open-source for trust and distribution. Open-core is the chosen model.",
  "Always test edge cases proactively. Duplicate detection, empty states, and boundary conditions matter.",
  "Prefer concise Slack-style communication for technical and founder-facing messages.",
  "Use a security-first zero-trust mindset when designing systems. Treat agents as untrusted actors.",

  // Business context
  "Operating as a foreign individual seller using W-8BEN. Using Lemon Squeezy for payments. Plan US LLC after revenue traction.",
  "Prioritize distribution and adoption speed over infrastructure optimization. Validate demand before over-engineering.",
  "ChatGPT transfer works via a prompt that makes ChatGPT extract memories, user copies clean output to Claude. No API needed.",

  // Technical decisions
  "Extend existing types (like MemoryWithScore) rather than creating parallel types. Minimal diff, DRY.",
  "Use content hash plus first-seen timestamp for file source freshness, not file mtime (mtime is unreliable after git clone).",
  "Duplicate detection uses Jaccard word overlap at 0.8 threshold for audit, and exact content match for import collision detection.",
];

async function run() {
  getDb();
  let imported = 0;
  let skipped = 0;

  const db = getDb();
  const checkStmt = db.prepare(
    "SELECT id FROM memories WHERE content = ? AND deleted_at IS NULL LIMIT 1"
  );

  for (const m of memories) {
    const existing = checkStmt.get(m) as { id: string } | undefined;
    if (existing) { skipped++; continue; }

    try {
      const embedding = await embed(m);
      store("session-memory", m, embedding, {
        scope: "user",
        tags: ["session-memory", `chat:${PROJECT}`],
      });
      imported++;
    } catch (err: any) {
      console.error("Failed:", m.slice(0, 50), err.message);
    }
  }

  console.log(`\nProject: ${PROJECT}`);
  console.log(`Imported: ${imported}`);
  console.log(`Skipped: ${skipped} (already exist)`);
  console.log(`Total in DB: ${(db.prepare("SELECT COUNT(*) as c FROM memories WHERE deleted_at IS NULL").get() as any).c}`);
}

run();
