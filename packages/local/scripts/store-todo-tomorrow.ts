import { getDb, store } from "../src/db.js";
import { embed } from "../src/embeddings.js";

const PROJECT = "CI Local Pro — TODOs for next session";

const memories = [
  "TODO: Dashboard should ask 'What are you working on?' on first load and show relevant memories first instead of a flat list.",
  "TODO: Multi-tool transfer support. Dropdown to pick source (ChatGPT, Gemini, Perplexity). Tailored extraction prompt per tool. Smart fallback parser with review-before-import step.",
  "TODO: Test the full install flow end-to-end on a clean machine. Verify token prompt, Node.js install, dependency install, ci dashboard launch.",
  "TODO: Add a 'What would you like to recall?' search prompt to the MCP context tool description so agents ask the user what they need instead of guessing.",
];

async function run() {
  const db = getDb();
  const checkStmt = db.prepare("SELECT id FROM memories WHERE content = ? AND deleted_at IS NULL LIMIT 1");
  let imported = 0;
  for (const m of memories) {
    if (checkStmt.get(m)) continue;
    const embedding = await embed(m);
    store("session-memory", m, embedding, { scope: "user", tags: ["todo", `chat:${PROJECT}`] });
    imported++;
  }
  console.log(`Saved ${imported} TODOs for next session.`);
}
run();
