import { getDb, store } from "../src/db.js";
import { embed } from "../src/embeddings.js";

const PROJECT = "CI Local Pro — Build Session 2026-04-03";

const memories = [
  // Strategic decisions
  "CI pivoted from Mem0 replacement to cross-tool memory layer after CEO review. The defensible moat is cross-tool portability, not features.",
  "Open-core licensing model: MCP server + file reading = open-source (trust + distribution). Dashboard + CLI tools = closed-source (revenue).",
  "The real competitor is a text file (CLAUDE.md). CI Local must be dramatically better than a file to justify existing.",
  "Hindsight by Vectorize is the strongest technical competitor: graph memory, cross-encoder reranking, MIT licensed, enterprise backed.",
  "Cross-tool memory portability is something no platform vendor will build because they want lock-in. This is CI's moat.",

  // Architecture shipped
  "CI Local reads config files from 7 platforms: CLAUDE.md, claude_memory, .cursor/rules, .windsurf/rules, codex.md, .github/copilot-instructions.md, .chatgpt/instructions.md.",
  "File source cache uses SQLite table with content_hash as primary key. Only re-embeds when content changes. First run slow, subsequent instant.",
  "Extended existing MemoryWithScore type with optional source, source_path, freshness_score, duplicate_group fields. Did not create a new type (DRY).",
  "Duplicate detection uses Jaccard word overlap at 0.8 threshold. Works well for near-identical text. Short memories (10-15 words) may not trigger due to small word sets.",
  "Freemium limit: 500 local memories. Nudge at 80% (400), stronger nudge at 90% (450), hard block at 500 with cloud upsell.",

  // Product decisions
  "ChatGPT transfer uses a prompt-based approach: ChatGPT extracts memories using a standard prompt, user copies clean output. No API, no share links, fully private.",
  "The extraction prompt includes a Project line so memories get auto-tagged with the ChatGPT conversation name.",
  "Dashboard at localhost:3141 has semantic search (embedding-based), project tag filtering, bulk select/delete, and a Transfer tab for ChatGPT import.",
  "Dashboard auto-detects Claude Code MEMORY.md files on first run. This is the wow moment for new users who already have Claude Code memories.",
  "Install script prompts for GitHub access token interactively. Reads from /dev/tty to work with curl pipe. Falls back to CI_TOKEN env var.",

  // Technical learnings
  "Landing page and API are separate Fly.io apps: centralintelligence-landing (nginx) and central-intelligence-api (Node.js). Deploy separately.",
  "Landing Dockerfile must explicitly COPY each file. Adding new files requires updating Dockerfile and redeploying.",
  "tsx eval mode cannot resolve relative imports. Use script files instead of inline -e for anything that imports project modules.",
  "The search debounce was increased to 500ms for semantic search because embedding the query takes longer than keyword matching.",
  "cosineSimilarity, temporalDecay, and rrf are duplicated between packages/local and packages/api. TODO: extract to shared package.",

  // User research insights
  "99.6% of Mem0 memories are garbage (user audit of 10,134 entries, only 38 survived unmodified). Memory quality is the category problem.",
  "Context rot is the deepest pain: long sessions die from contradictory context. Old memories alongside newer ones create confusion.",
  "300% higher user satisfaction when chatbots remember previous context. The gap between tolerated tool and loved tool.",
  "Agent memory systems commonly make things worse because the system's confidence becomes inversely correlated with its reliability.",
  "The 5 things memory users want most: pattern learning, transparency/control, scoping/isolation, temporal reasoning, affordable graph memory.",

  // What shipped today
  "Shipped v0.5.0 of central-intelligence with cross-tool file reading, smart recall signals, 31 tests, ChatGPT support.",
  "Created ci-local-pro private repo with 8 CLI commands: audit, dashboard, init, test, export, import, chatgpt-init, chatgpt-import.",
  "Built dashboard landing page at centralintelligence.online/dashboard.html with fake screenshot, feature cards, transfer section.",
  "Created cross-platform install scripts (Mac/Linux/Windows) with Node.js auto-install and GitHub token auth.",
  "GitHub release v0.1.0 of ci-local-pro with tarball for download.",
];

async function run() {
  const db = getDb();
  const checkStmt = db.prepare(
    "SELECT id FROM memories WHERE content = ? AND deleted_at IS NULL LIMIT 1"
  );

  let imported = 0;
  let skipped = 0;

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
      if (imported % 10 === 0) console.log(`  ${imported}...`);
    } catch (err: any) {
      console.error("Failed:", m.slice(0, 50), err.message);
    }
  }

  const total = (db.prepare("SELECT COUNT(*) as c FROM memories WHERE deleted_at IS NULL").get() as any).c;
  console.log(`\nProject: ${PROJECT}`);
  console.log(`Imported: ${imported} new`);
  console.log(`Skipped: ${skipped} (already exist)`);
  console.log(`Total in DB: ${total}`);
}

run();
