import { Hono } from "hono";
import { embed } from "../services/embeddings.js";

const demo = new Hono();

// Pre-loaded knowledge base about Central Intelligence
const DEMO_MEMORIES = [
  {
    id: "demo-001",
    content: "Central Intelligence is a persistent memory service for AI agents. It lets agents store, recall, and share knowledge across sessions using semantic search.",
    tags: ["overview", "product"],
  },
  {
    id: "demo-002",
    content: "CI supports five core operations: remember (store), recall (search), context (auto-load), forget (delete), and share (cross-agent visibility).",
    tags: ["features", "tools"],
  },
  {
    id: "demo-003",
    content: "Agents can pay per-call with USDC on Base network via the x402 protocol. No signup required — just send payment with the request. Cost is $0.001 per operation.",
    tags: ["payments", "x402", "crypto"],
  },
  {
    id: "demo-004",
    content: "CI works with Claude Code, Cursor, Windsurf, LangChain, CrewAI, AutoGen, OpenAI GPTs, Lovable, and any MCP-compatible client.",
    tags: ["integrations", "compatibility"],
  },
  {
    id: "demo-005",
    content: "Memory scopes control visibility: agent (private), user (all your agents), org (all agents in the organization). Use share to promote memories across scopes.",
    tags: ["scoping", "sharing"],
  },
  {
    id: "demo-006",
    content: "The free tier includes 500 memory operations per month. No credit card required. Sign up with: npx central-intelligence-cli signup",
    tags: ["pricing", "free-tier"],
  },
  {
    id: "demo-007",
    content: "CI is open source under the MIT license. Self-hosting is supported with your own PostgreSQL database and OpenAI API key for embeddings.",
    tags: ["open-source", "self-hosting"],
  },
  {
    id: "demo-008",
    content: "Semantic search uses OpenAI text-embedding-3-small vectors with cosine similarity ranking. Queries find relevant memories by meaning, not just keywords.",
    tags: ["architecture", "search"],
  },
  {
    id: "demo-009",
    content: "Install the MCP server with: npx central-intelligence-mcp. Configure with CI_API_KEY environment variable. Works with any MCP-compatible AI coding tool.",
    tags: ["setup", "mcp"],
  },
  {
    id: "demo-010",
    content: "The Python SDK is available on PyPI: pip install central-intelligence. Use CentralIntelligence class for remember, recall, forget, and share operations.",
    tags: ["python", "sdk"],
  },
  {
    id: "demo-011",
    content: "CI stores memories as vector embeddings in PostgreSQL with JSONB. Cosine similarity is computed in the application layer for fast semantic matching.",
    tags: ["architecture", "database"],
  },
  {
    id: "demo-012",
    content: "Cross-agent memory sharing enables team knowledge: one agent discovers a bug pattern, all other agents in the org instantly know about it.",
    tags: ["collaboration", "teams"],
  },
];

// Cache embeddings so we only compute once
let cachedEmbeddings: { content: string; embedding: number[] }[] | null = null;
let cacheReady = false;
let cachePromise: Promise<void> | null = null;

async function ensureCache() {
  if (cacheReady) return;
  if (cachePromise) {
    await cachePromise;
    return;
  }
  cachePromise = (async () => {
    const texts = DEMO_MEMORIES.map((m) => m.content);
    cachedEmbeddings = [];
    for (const text of texts) {
      const emb = await embed(text);
      cachedEmbeddings.push({ content: text, embedding: emb });
    }
    cacheReady = true;
  })();
  await cachePromise;
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// Rate limit: 10 queries per IP per hour
const demoLimits = new Map<string, { count: number; reset: number }>();

demo.post("/recall", async (c) => {
  const ip = c.req.header("x-forwarded-for") || "unknown";
  const now = Date.now();
  const limit = demoLimits.get(ip);
  if (limit && now < limit.reset) {
    if (limit.count >= 10) {
      return c.json({
        error: "Demo rate limit exceeded (10 queries/hour). Sign up for free at https://centralintelligence.online for 500 ops/month.",
      }, 429);
    }
    limit.count++;
  } else {
    demoLimits.set(ip, { count: 1, reset: now + 3600000 });
  }

  const body = await c.req.json().catch(() => ({}));
  const query = body.query || body.q || "";

  if (!query || typeof query !== "string" || query.length < 2) {
    return c.json({ error: "Provide a 'query' field (min 2 chars)" }, 400);
  }

  if (query.length > 500) {
    return c.json({ error: "Query too long (max 500 chars)" }, 400);
  }

  await ensureCache();

  const queryEmbedding = await embed(query);
  const results = cachedEmbeddings!
    .map((item, i) => ({
      ...DEMO_MEMORIES[i],
      similarity: Math.round(cosineSimilarity(queryEmbedding, item.embedding) * 1000) / 1000,
    }))
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, body.top_k || 3);

  return c.json({
    demo: true,
    note: "This searches a pre-loaded knowledge base about Central Intelligence. Sign up free to store your own memories.",
    query,
    memories: results,
    signup: "https://centralintelligence.online",
  });
});

export const demoRouter = demo;
