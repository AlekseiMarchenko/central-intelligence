/**
 * Central Intelligence Memory Retrieval Benchmark
 *
 * Tests hybrid retrieval (vector + BM25 + trigram + temporal decay)
 * against realistic agent memory scenarios.
 *
 * Categories:
 * 1. Semantic similarity (paraphrased queries)
 * 2. Exact keyword matching (technical terms)
 * 3. Typo tolerance (misspelled queries)
 * 4. Temporal relevance (old vs new conflicting info)
 * 5. Cross-domain recall (coding + human context)
 * 6. Negative queries (should return low scores)
 */

const API_BASE = process.env.API_BASE || "https://central-intelligence-api.fly.dev";
const API_KEY = process.env.CI_API_KEY || "";
const AGENT_ID = "benchmark-agent-001";

interface BenchmarkCase {
  category: string;
  query: string;
  expected_content_keywords: string[]; // at least one must appear in top results
  unexpected_keywords?: string[];       // should NOT appear in top results
  description: string;
}

// --- Seed memories ---

const SEED_MEMORIES = [
  // Architecture decisions
  { content: "The project uses PostgreSQL 15 with JSONB for storing embeddings. We chose Postgres over MongoDB because we needed ACID transactions for payment processing.", tags: ["architecture", "database"] },
  { content: "Authentication is handled via JWT tokens stored in httpOnly cookies. We rejected session-based auth because the API needs to be stateless for horizontal scaling.", tags: ["architecture", "auth"] },
  { content: "The frontend uses React 18 with TypeScript. We chose React over Vue because the team has more React experience.", tags: ["architecture", "frontend"] },
  { content: "API rate limiting is implemented using a sliding window algorithm with in-memory counters. Redis was considered but rejected to avoid another infrastructure dependency.", tags: ["architecture", "security"] },

  // Bug fixes
  { content: "Fixed a critical SQL injection vulnerability in the recall endpoint. The issue was using sql.unsafe() instead of parameterized queries. CVE-2026-XXXX.", tags: ["bugfix", "security"] },
  { content: "Resolved memory leak in the WebSocket handler caused by event listeners not being cleaned up on disconnect. Added proper cleanup in the onClose handler.", tags: ["bugfix", "performance"] },
  { content: "Fixed CORS preflight failing for x402 payment endpoints. The issue was that OPTIONS requests were being blocked by the auth middleware.", tags: ["bugfix", "cors"] },

  // User preferences
  { content: "User prefers TypeScript over JavaScript for all new code. Use strict mode and avoid any types.", tags: ["preference", "coding"] },
  { content: "User wants all API responses to use camelCase, not snake_case. This applies to JSON keys in both requests and responses.", tags: ["preference", "api"] },
  { content: "User prefers functional programming patterns over class-based OOP. Use pure functions, avoid mutation, prefer map/filter/reduce.", tags: ["preference", "coding"] },

  // Project context
  { content: "The deployment target is Fly.io with auto-scaling. Production runs on shared-cpu-1x machines with 256MB RAM. Database is on a separate Fly Postgres instance.", tags: ["deployment", "infrastructure"] },
  { content: "The project is MIT licensed and open source on GitHub at AlekseiMarchenko/central-intelligence. All contributions must pass CI before merging.", tags: ["project", "legal"] },
  { content: "Pricing tiers: Free (500 ops/month), Pro ($29/month), Team ($99/month), Enterprise (custom). USDC payments on Base network also supported.", tags: ["business", "pricing"] },

  // Technical details
  { content: "Embeddings use OpenAI text-embedding-3-small model which produces 1536-dimensional vectors. Cosine similarity is computed in the application layer, not in Postgres.", tags: ["technical", "embeddings"] },
  { content: "The MCP server runs as a stdio transport. It connects to the API via HTTPS and requires CI_API_KEY environment variable for authentication.", tags: ["technical", "mcp"] },
  { content: "Error handling follows fail-open pattern: if the memory API is unreachable, the agent continues without memory rather than blocking the session.", tags: ["technical", "resilience"] },

  // Human context (harder to retrieve)
  { content: "The CEO review meeting is every Thursday at 2pm. Aleksei presents product updates and the team discusses priorities for the next sprint.", tags: ["meetings", "process"] },
  { content: "The main competitor Mem0 raised $24M but only achieves 53% accuracy on LoCoMo benchmark. Their weakness is write-time processing that loses information.", tags: ["competitive", "strategy"] },
  { content: "Non-technical founders are the primary target audience. They don't want to configure anything — the product should 'just work' with zero setup.", tags: ["strategy", "users"] },
];

// --- Benchmark cases ---

const BENCHMARK_CASES: BenchmarkCase[] = [
  // Category 1: Semantic similarity (paraphrased queries)
  {
    category: "semantic",
    query: "what database engine does the project use and why",
    expected_content_keywords: ["PostgreSQL", "ACID", "MongoDB"],
    description: "Paraphrased architecture question",
  },
  {
    category: "semantic",
    query: "how do users log in to the system",
    expected_content_keywords: ["JWT", "httpOnly", "auth"],
    description: "Semantic match for auth architecture",
  },
  {
    category: "semantic",
    query: "who are we building this product for",
    expected_content_keywords: ["Non-technical", "founders", "zero setup"],
    description: "Strategic question about target users",
  },
  {
    category: "semantic",
    query: "what happens when the API goes down",
    expected_content_keywords: ["fail-open", "unreachable", "continues"],
    description: "Resilience pattern question",
  },

  // Category 2: Exact keyword matching (BM25 strength)
  {
    category: "keyword",
    query: "SQL injection CVE vulnerability",
    expected_content_keywords: ["SQL injection", "CVE", "sql.unsafe"],
    description: "Exact technical term matching",
  },
  {
    category: "keyword",
    query: "text-embedding-3-small 1536 dimensions",
    expected_content_keywords: ["text-embedding-3-small", "1536"],
    description: "Model name and dimension lookup",
  },
  {
    category: "keyword",
    query: "Fly.io shared-cpu-1x 256MB",
    expected_content_keywords: ["Fly.io", "shared-cpu-1x", "256MB"],
    description: "Infrastructure spec lookup",
  },
  {
    category: "keyword",
    query: "httpOnly cookies JWT stateless",
    expected_content_keywords: ["JWT", "httpOnly", "stateless"],
    description: "Multiple keyword conjunction",
  },

  // Category 3: Typo tolerance (trigram strength)
  {
    category: "typo",
    query: "PostgrSQL databse",
    expected_content_keywords: ["PostgreSQL"],
    description: "Misspelled database name",
  },
  {
    category: "typo",
    query: "authentification with Jason Web Tokens",
    expected_content_keywords: ["JWT", "auth"],
    description: "Misspelled authentication + JWT",
  },
  {
    category: "typo",
    query: "Typscript vs Javscript preference",
    expected_content_keywords: ["TypeScript", "JavaScript"],
    description: "Misspelled language names",
  },

  // Category 4: Cross-domain (human context)
  {
    category: "cross-domain",
    query: "when is the leadership meeting",
    expected_content_keywords: ["Thursday", "2pm", "CEO"],
    description: "Non-technical meeting query",
  },
  {
    category: "cross-domain",
    query: "how much does the pro plan cost",
    expected_content_keywords: ["$29", "Pro"],
    description: "Business pricing question",
  },
  {
    category: "cross-domain",
    query: "what are the competitors doing wrong",
    expected_content_keywords: ["Mem0", "53%", "accuracy"],
    description: "Competitive intelligence query",
  },

  // Category 5: Coding style preferences
  {
    category: "preference",
    query: "should I use classes or functions",
    expected_content_keywords: ["functional", "pure functions", "class"],
    description: "Coding style preference",
  },
  {
    category: "preference",
    query: "what format for API response keys",
    expected_content_keywords: ["camelCase", "snake_case"],
    description: "API convention preference",
  },

  // Category 6: Negative queries (should return low relevance)
  {
    category: "negative",
    query: "recipe for chocolate cake",
    expected_content_keywords: [],
    description: "Completely irrelevant query — scores should be low",
  },
  {
    category: "negative",
    query: "weather forecast for Tokyo tomorrow",
    expected_content_keywords: [],
    description: "Unrelated domain query",
  },
];

// --- Helpers ---

async function apiCall(path: string, body: any): Promise<any> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${API_KEY}`,
    },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function seedMemories(): Promise<void> {
  console.log(`\nSeeding ${SEED_MEMORIES.length} memories...`);
  for (const mem of SEED_MEMORIES) {
    await apiCall("/memories/remember", {
      agent_id: AGENT_ID,
      content: mem.content,
      tags: mem.tags,
    });
    process.stdout.write(".");
  }
  console.log(" done\n");
}

async function cleanupMemories(): Promise<void> {
  console.log("Cleaning up benchmark memories...");
  // Recall all and delete
  const result = await apiCall("/memories/recall", {
    agent_id: AGENT_ID,
    query: "benchmark",
    limit: 100,
  });
  for (const mem of result.memories || []) {
    await apiCall("/memories/forget", {
      agent_id: AGENT_ID,
      memory_id: mem.id,
    });
  }
}

function containsKeyword(text: string, keywords: string[]): boolean {
  const lower = text.toLowerCase();
  return keywords.some(k => lower.includes(k.toLowerCase()));
}

// --- Run benchmark ---

async function runBenchmark(): Promise<void> {
  console.log("═══════════════════════════════════════════════════════");
  console.log("  CENTRAL INTELLIGENCE — RETRIEVAL BENCHMARK");
  console.log("  Hybrid: Vector + BM25 + Trigram + Temporal Decay");
  console.log("═══════════════════════════════════════════════════════");

  // Seed
  await seedMemories();

  // Wait a moment for indexing
  await new Promise(r => setTimeout(r, 2000));

  const results: {
    category: string;
    description: string;
    query: string;
    hit: boolean;
    top_score: number;
    top_content: string;
    result_count: number;
  }[] = [];

  console.log("Running benchmark cases...\n");

  for (const tc of BENCHMARK_CASES) {
    const response = await apiCall("/memories/recall", {
      agent_id: AGENT_ID,
      query: tc.query,
      limit: 5,
    });

    const memories = response.memories || [];
    const topContent = memories.map((m: any) => m.content).join(" ");
    const topScore = memories[0]?.relevance_score || 0;

    let hit: boolean;
    if (tc.category === "negative") {
      // For negative queries, success = low scores (< 0.3 for top result)
      hit = topScore < 0.005 || memories.length === 0;
    } else {
      // For positive queries, success = expected keywords in top 3 results
      const top3Content = memories.slice(0, 3).map((m: any) => m.content).join(" ");
      hit = containsKeyword(top3Content, tc.expected_content_keywords);
    }

    results.push({
      category: tc.category,
      description: tc.description,
      query: tc.query,
      hit,
      top_score: topScore,
      top_content: memories[0]?.content?.slice(0, 80) || "(no results)",
      result_count: memories.length,
    });

    const icon = hit ? "✅" : "❌";
    console.log(`${icon} [${tc.category.padEnd(12)}] ${tc.description}`);
    console.log(`   Query: "${tc.query}"`);
    console.log(`   Top score: ${topScore} | Results: ${memories.length}`);
    if (memories[0]) {
      console.log(`   Top hit: "${memories[0].content.slice(0, 100)}..."`);
    }
    console.log();
  }

  // --- Summary ---
  console.log("═══════════════════════════════════════════════════════");
  console.log("  RESULTS SUMMARY");
  console.log("═══════════════════════════════════════════════════════\n");

  const categories = [...new Set(results.map(r => r.category))];
  let totalHits = 0;
  let totalCases = 0;

  for (const cat of categories) {
    const catResults = results.filter(r => r.category === cat);
    const catHits = catResults.filter(r => r.hit).length;
    const catTotal = catResults.length;
    const pct = Math.round((catHits / catTotal) * 100);

    totalHits += catHits;
    totalCases += catTotal;

    const bar = "█".repeat(Math.round(pct / 5)) + "░".repeat(20 - Math.round(pct / 5));
    console.log(`  ${cat.padEnd(14)} ${bar} ${pct}% (${catHits}/${catTotal})`);
  }

  const overallPct = Math.round((totalHits / totalCases) * 100);
  console.log();
  console.log(`  ${"OVERALL".padEnd(14)} ${"█".repeat(Math.round(overallPct / 5))}${"░".repeat(20 - Math.round(overallPct / 5))} ${overallPct}% (${totalHits}/${totalCases})`);
  console.log();

  // Cleanup
  console.log("Cleaning up...");
  await cleanupMemories();

  console.log("\nBenchmark complete.");
  process.exit(overallPct >= 70 ? 0 : 1);
}

// Run
if (!API_KEY) {
  console.error("Error: CI_API_KEY environment variable required");
  console.error("Usage: CI_API_KEY=ci_sk_... npx tsx src/benchmark.ts");
  process.exit(1);
}

runBenchmark().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
