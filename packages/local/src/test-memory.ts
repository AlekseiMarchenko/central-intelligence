import { embed } from "./embeddings.js";
import { store, getMemoryCount } from "./db.js";
import { hybridSearch } from "./search.js";

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

const TEST_AGENT_ID = "ci-test-memory";
const TEST_CONTENT = "Setup completed via /agent page. This is a test memory written by `ci test-memory`.";
const TEST_QUERY = "setup via agent page";

export async function testMemoryCommand(): Promise<void> {
  console.log("");
  console.log(`${BOLD}ci test-memory${RESET} ${DIM}— round-trip a memory through remember + recall${RESET}`);
  console.log("");

  // --- Step 1: remember() ---
  let contentEmbedding: number[] = [];
  const remembered = await timed(async () => {
    console.log(`${DIM}→ remember(${RESET}${JSON.stringify(TEST_CONTENT.slice(0, 48) + "…")}${DIM})${RESET}`);
    contentEmbedding = await embed(TEST_CONTENT);
    const memory = store(TEST_AGENT_ID, TEST_CONTENT, contentEmbedding, { scope: "agent" });
    return memory;
  });
  if (!remembered.ok) {
    console.log(`  ${RED}✗ remember failed:${RESET} ${remembered.err}`);
    process.exit(1);
  }
  console.log(`  ${GREEN}✓ stored${RESET} ${DIM}memory_id=${remembered.value.id} (${remembered.ms}ms)${RESET}`);

  // --- Step 2: recall() via hybridSearch ---
  const recalled = await timed(async () => {
    console.log(`${DIM}→ recall(${RESET}${JSON.stringify(TEST_QUERY)}${DIM})${RESET}`);
    const results = await hybridSearch(TEST_AGENT_ID, TEST_QUERY, { limit: 5 });
    return results;
  });
  if (!recalled.ok) {
    console.log(`  ${RED}✗ recall failed:${RESET} ${recalled.err}`);
    process.exit(1);
  }
  const hits = recalled.value;
  if (hits.length === 0) {
    console.log(`  ${YELLOW}○ no matches${RESET} ${DIM}(something is off — the memory was stored but did not come back)${RESET}`);
    process.exit(2);
  }
  const top = hits[0];
  // Compute cosine similarity between query and content embedding — the
  // "score" users intuitively expect (semantic similarity, 0-1). The
  // hybridSearch pipeline returns a blended RRF score which is a different
  // number and confuses first-time users.
  const queryEmbedding = await embed(TEST_QUERY);
  const cosine = cosineSimilarity(queryEmbedding, contentEmbedding);
  const scoreStr = `score=${cosine.toFixed(2)}`;
  console.log(`  ${GREEN}✓ found ${hits.length} match${hits.length === 1 ? "" : "es"}${RESET} ${DIM}${scoreStr} (${recalled.ms}ms)${RESET}`);

  // Show the top hit content preview so it's clearly the same memory
  const preview = (top.content || "").slice(0, 72);
  console.log(`  ${DIM}→ "${preview}${(top.content || "").length > 72 ? "…" : ""}"${RESET}`);

  // --- Step 3: confirm count ---
  const count = getMemoryCount();
  console.log("");
  console.log(`${BOLD}Pass.${RESET} ${DIM}remember + recall round-trip succeeded.${RESET}`);
  console.log(`${DIM}Total memories in DB: ${count}${RESET}`);
  console.log("");
}

async function timed<T>(fn: () => Promise<T> | T): Promise<
  | { ok: true; value: T; ms: number }
  | { ok: false; err: string; ms: number }
> {
  const t0 = Date.now();
  try {
    const value = await fn();
    return { ok: true, value, ms: Date.now() - t0 };
  } catch (err: any) {
    return { ok: false, err: err?.message || String(err), ms: Date.now() - t0 };
  }
}
