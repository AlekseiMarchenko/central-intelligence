import { embed } from "./embeddings.js";
import { store, getMemoryCount } from "./db.js";
import { hybridSearch } from "./search.js";
import { detectMode, apiCall } from "./cloud.js";

const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

const TEST_AGENT_ID = "ci-test-memory";
const TEST_CONTENT = "Setup completed via /agent page. This is a test memory written by `ci test-memory`.";
const TEST_QUERY = "setup via agent page";

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

export async function testMemoryCommand(): Promise<void> {
  const mode = detectMode();
  console.log("");
  console.log(`${BOLD}ci test-memory${RESET} ${DIM}— round-trip a memory through remember + recall${RESET}`);

  if (mode.kind === "cloud") {
    console.log(`${DIM}mode: cloud (${mode.apiUrl})${RESET}`);
    console.log("");
    await testMemoryCloud(mode);
    return;
  }

  console.log(`${DIM}mode: local (~/.central-intelligence/memories.db)${RESET}`);
  console.log("");
  await testMemoryLocal();
}

// --- Cloud path: POST /memories/remember then POST /memories/recall ---
async function testMemoryCloud(mode: Extract<ReturnType<typeof detectMode>, { kind: "cloud" }>) {
  const remembered = await timed(async () => {
    console.log(`${DIM}→ remember(${RESET}${JSON.stringify(TEST_CONTENT.slice(0, 48) + "…")}${DIM})${RESET}`);
    return apiCall(mode, "/memories/remember", {
      method: "POST",
      body: {
        agent_id: TEST_AGENT_ID,
        content: TEST_CONTENT,
        scope: "agent",
        tags: ["ci-test"],
      },
    }) as Promise<{ memory?: { id: string } }>;
  });
  if (!remembered.ok) {
    console.log(`  ${RED}✗ remember failed:${RESET} ${remembered.err}`);
    process.exit(1);
  }
  const memId = remembered.value?.memory?.id ?? "(id missing from response)";
  console.log(`  ${GREEN}✓ stored${RESET} ${DIM}memory_id=${memId} (${remembered.ms}ms)${RESET}`);

  const recalled = await timed(async () => {
    console.log(`${DIM}→ recall(${RESET}${JSON.stringify(TEST_QUERY)}${DIM})${RESET}`);
    return apiCall(mode, "/memories/recall", {
      method: "POST",
      body: {
        agent_id: TEST_AGENT_ID,
        query: TEST_QUERY,
        limit: 5,
      },
    }) as Promise<{ memories?: Array<{ id: string; content: string; relevance_score?: number }> }>;
  });
  if (!recalled.ok) {
    console.log(`  ${RED}✗ recall failed:${RESET} ${recalled.err}`);
    process.exit(1);
  }
  const hits = recalled.value?.memories ?? [];
  if (hits.length === 0) {
    console.log(`  ${YELLOW}○ no matches${RESET} ${DIM}(memory was stored on the cloud but did not come back from recall)${RESET}`);
    process.exit(2);
  }
  const top = hits[0];
  const score = typeof top.relevance_score === "number" ? top.relevance_score : null;
  const scoreStr = score !== null ? `score=${score.toFixed(2)}` : "";
  console.log(`  ${GREEN}✓ found ${hits.length} match${hits.length === 1 ? "" : "es"}${RESET} ${DIM}${scoreStr} (${recalled.ms}ms)${RESET}`);
  const preview = (top.content || "").slice(0, 72);
  console.log(`  ${DIM}→ "${preview}${(top.content || "").length > 72 ? "…" : ""}"${RESET}`);

  console.log("");
  console.log(`${BOLD}Pass.${RESET} ${DIM}remember + recall round-trip through the cloud succeeded.${RESET}`);
  console.log(`${DIM}Dashboard: https://centralintelligence.online/dashboard${RESET}`);
  console.log("");
}

// --- Local path: store() + hybridSearch() against local SQLite ---
async function testMemoryLocal() {
  let contentEmbedding: number[] = [];
  const remembered = await timed(async () => {
    console.log(`${DIM}→ remember(${RESET}${JSON.stringify(TEST_CONTENT.slice(0, 48) + "…")}${DIM})${RESET}`);
    contentEmbedding = await embed(TEST_CONTENT);
    return store(TEST_AGENT_ID, TEST_CONTENT, contentEmbedding, { scope: "agent" });
  });
  if (!remembered.ok) {
    console.log(`  ${RED}✗ remember failed:${RESET} ${remembered.err}`);
    process.exit(1);
  }
  console.log(`  ${GREEN}✓ stored${RESET} ${DIM}memory_id=${remembered.value.id} (${remembered.ms}ms)${RESET}`);

  const recalled = await timed(async () => {
    console.log(`${DIM}→ recall(${RESET}${JSON.stringify(TEST_QUERY)}${DIM})${RESET}`);
    return hybridSearch(TEST_AGENT_ID, TEST_QUERY, { limit: 5 });
  });
  if (!recalled.ok) {
    console.log(`  ${RED}✗ recall failed:${RESET} ${recalled.err}`);
    process.exit(1);
  }
  const hits = recalled.value;
  if (hits.length === 0) {
    console.log(`  ${YELLOW}○ no matches${RESET} ${DIM}(the memory was stored but did not come back)${RESET}`);
    process.exit(2);
  }
  const top = hits[0];
  const queryEmbedding = await embed(TEST_QUERY);
  const cosine = cosineSimilarity(queryEmbedding, contentEmbedding);
  const scoreStr = `score=${cosine.toFixed(2)}`;
  console.log(`  ${GREEN}✓ found ${hits.length} match${hits.length === 1 ? "" : "es"}${RESET} ${DIM}${scoreStr} (${recalled.ms}ms)${RESET}`);
  const preview = (top.content || "").slice(0, 72);
  console.log(`  ${DIM}→ "${preview}${(top.content || "").length > 72 ? "…" : ""}"${RESET}`);

  const count = getMemoryCount();
  console.log("");
  console.log(`${BOLD}Pass.${RESET} ${DIM}remember + recall round-trip through local SQLite succeeded.${RESET}`);
  console.log(`${DIM}Total memories in local DB: ${count}${RESET}`);
  console.log("");
}
