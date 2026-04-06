import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { bodyLimit } from "hono/body-limit";
import { serve } from "@hono/node-server";
import { authMiddleware } from "./middleware/auth.js";
import {
  rateLimitMiddleware,
  memoryLimitMiddleware,
  ipRateLimitMiddleware,
} from "./middleware/ratelimit.js";
import { memoriesRouter } from "./routes/memories.js";
import { keysRouter } from "./routes/keys.js";
import { usageRouter } from "./routes/usage.js";
import { docsRouter } from "./routes/docs.js";
import { dashboardRouter } from "./routes/dashboard.js";
import { appRouter } from "./routes/app.js";
import { paymentsRouter } from "./routes/payments.js";
import { billingMiddleware } from "./middleware/billing.js";
import { x402Middleware } from "./middleware/x402.js";
import { demoRouter } from "./routes/demo.js";
import { sql } from "./db/connection.js";

const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",")
  : ["https://centralintelligence.online", "https://central-intelligence-api.fly.dev"];

const app = new Hono();

// Global middleware
app.use(
  "*",
  cors({
    origin: (origin) => {
      // Allow requests with no origin (curl, MCP servers, server-to-server)
      // Return null (no CORS header) instead of "*" to avoid wildcard + credentials conflict
      if (!origin) return null as any;
      // Allow configured origins
      if (ALLOWED_ORIGINS.includes(origin)) return origin;
      // Allow localhost for development
      if (origin.startsWith("http://localhost:")) return origin;
      // Block all others
      return "";
    },
    credentials: true,
  }),
);
app.use("*", logger());
// Limit request body to 64KB (10KB content + overhead for JSON structure)
app.use("*", bodyLimit({ maxSize: 64 * 1024 }));

// Health check
app.get("/", (c) =>
  c.json({
    name: "Central Intelligence",
    tagline: "Agents forget. CI remembers.",
    version: "1.0.0",
    docs: "/docs",
  }),
);

app.get("/health", (c) => c.json({ status: "ok" }));

// Install script — served as plain text for curl | sh
app.get("/install.sh", async (c) => {
  try {
    const { readFileSync } = await import("fs");
    const { join } = await import("path");
    // Serve from landing directory (co-located in the repo)
    const script = readFileSync(join(import.meta.dirname || ".", "..", "..", "landing", "install.sh"), "utf-8");
    return c.text(script);
  } catch {
    // Fallback: redirect to GitHub raw
    return c.redirect("https://raw.githubusercontent.com/AlekseiMarchenko/central-intelligence/main/landing/install.sh");
  }
});

// Windows install script
app.get("/install.ps1", async (c) => {
  try {
    const { readFileSync } = await import("fs");
    const { join } = await import("path");
    const script = readFileSync(join(import.meta.dirname || ".", "..", "..", "landing", "install.ps1"), "utf-8");
    return c.text(script);
  } catch {
    return c.redirect("https://raw.githubusercontent.com/AlekseiMarchenko/central-intelligence/main/landing/install.ps1");
  }
});

// Version check — used by CI Local for update notifications + install tracking
app.get("/versions/local", async (c) => {
  const current = c.req.query("current") || "unknown";

  // Log the check (anonymous — just version and timestamp)
  try {
    const { sql } = await import("./db/connection.js");
    await sql`
      INSERT INTO usage_events (api_key_id, event_type, agent_id, tokens)
      VALUES ('00000000-0000-0000-0000-000000000000', 'version_check', ${`local-${current}`}, 0)
    `.catch(() => {});
  } catch {}

  return c.json({
    latest: "1.1.0",
    current,
    update_available: current !== "1.1.0",
    message: current !== "1.1.0"
      ? "Update available: npm install -g central-intelligence-local"
      : undefined,
    cloud_promo: "Need cross-device sync? Try cloud mode: npx central-intelligence-cli signup",
  });
});

// MCP Manifest — universal auto-discovery (mcp-manifest spec v1.0)
app.get("/.well-known/mcp-manifest.json", (c) =>
  c.json({
    manifest_version: "1.0",
    server: {
      name: "Central Intelligence",
      description: "Persistent memory for AI agents. Store, recall, and share knowledge across sessions.",
      version: "1.0.0",
      homepage: "https://centralintelligence.online",
      repository: "https://github.com/AlekseiMarchenko/central-intelligence",
      license: "MIT",
      author: { name: "Aleksei Marchenko", url: "https://github.com/AlekseiMarchenko" },
    },
    install: [{ type: "npm", package: "central-intelligence-mcp", command: "npx", args: ["central-intelligence-mcp"] }],
    config: [
      { name: "CI_API_KEY", description: "Your Central Intelligence API key", required: true, secret: true, type: "string", prompt: "Get one free: npx central-intelligence-cli signup", obtain_url: "https://centralintelligence.online" },
      { name: "CI_API_URL", description: "API base URL (only for self-hosted)", required: false, type: "url", default: "https://central-intelligence-api.fly.dev" },
    ],
    transport: {
      stdio: { command: "npx", args: ["central-intelligence-mcp"], env: { CI_API_KEY: "{{CI_API_KEY}}" } },
      http: { base_url: "https://central-intelligence-api.fly.dev", auth: "bearer", docs_url: "https://central-intelligence-api.fly.dev/docs" },
    },
    tools: [
      { name: "remember", description: "Store information for later recall" },
      { name: "recall", description: "Search memories by meaning, not just keywords" },
      { name: "context", description: "Auto-load relevant context for the current task" },
      { name: "forget", description: "Delete outdated or incorrect memories" },
      { name: "share", description: "Share memories across agents (agent/user/org scope)" },
    ],
    when_to_use: {
      scenarios: [
        { trigger: "Starting a new session on an existing project", action: "Call context to load project knowledge" },
        { trigger: "Making an important decision", action: "Call remember to store the decision and rationale" },
        { trigger: "Debugging a recurring issue", action: "Call recall to find previous debugging sessions" },
      ],
      heuristic: "If you would write it in a README or CLAUDE.md, store it as a memory instead.",
    },
    pricing: { model: "freemium", free_tier: "500 operations/month, no credit card required" },
    clients: {
      claude: { config_path: "~/.claude/settings.json", config_key: "mcpServers", template: { "central-intelligence": { command: "npx", args: ["central-intelligence-mcp"], env: { CI_API_KEY: "{{CI_API_KEY}}" } } } },
      cursor: { config_path: "~/.cursor/mcp.json", config_key: "mcpServers", template: { "central-intelligence": { command: "npx", args: ["central-intelligence-mcp"], env: { CI_API_KEY: "{{CI_API_KEY}}" } } } },
      windsurf: { config_path: "~/.codeium/windsurf/mcp_config.json", config_key: "mcpServers", template: { "central-intelligence": { command: "npx", args: ["central-intelligence-mcp"], env: { CI_API_KEY: "{{CI_API_KEY}}" } } } },
    },
  })
);

// Legacy MCP discovery (keep for backwards compatibility)
app.get("/.well-known/mcp", (c) =>
  c.json({
    name: "Central Intelligence",
    description: "Persistent memory for AI agents. Store, recall, and share knowledge across sessions.",
    version: "1.0.0",
    homepage: "https://centralintelligence.online",
    documentation: "https://central-intelligence-api.fly.dev/docs",
    repository: "https://github.com/AlekseiMarchenko/central-intelligence",
    transport: {
      stdio: {
        command: "npx",
        args: ["central-intelligence-mcp"],
        env: { CI_API_KEY: "your-api-key" },
      },
      http: {
        base_url: "https://central-intelligence-api.fly.dev",
        auth: "bearer",
        x402: {
          enabled: true,
          base_url: "https://central-intelligence-api.fly.dev/x402",
          price_per_call_usd: 0.001,
          network: "base",
          token: "USDC",
        },
      },
    },
    tools: [
      {
        name: "remember",
        description: "Store information for later recall. The agent builds institutional knowledge over time.",
        endpoint: "POST /memories/remember",
        x402_endpoint: "POST /x402/remember",
        input: {
          agent_id: { type: "string", required: true, description: "Unique agent identifier" },
          content: { type: "string", required: true, description: "The information to remember" },
          tags: { type: "string[]", required: false, description: "Optional tags for categorization" },
          scope: { type: "string", required: false, enum: ["agent", "user", "org"], default: "agent" },
        },
      },
      {
        name: "recall",
        description: "Semantic search across all stored memories. Finds relevant information by meaning, not just keywords.",
        endpoint: "POST /memories/recall",
        x402_endpoint: "POST /x402/recall",
        input: {
          agent_id: { type: "string", required: true },
          query: { type: "string", required: true, description: "Natural language search query" },
          limit: { type: "number", required: false, default: 5 },
        },
      },
      {
        name: "context",
        description: "Auto-load relevant memories for the current task. Describe what you're working on, get back everything relevant.",
        endpoint: "POST /memories/context",
        x402_endpoint: "POST /x402/context",
        input: {
          agent_id: { type: "string", required: true },
          query: { type: "string", required: true, description: "Current task description" },
        },
      },
      {
        name: "forget",
        description: "Delete a memory by ID. Keep knowledge accurate by removing outdated information.",
        endpoint: "POST /memories/forget",
        x402_endpoint: "POST /x402/forget",
        input: {
          agent_id: { type: "string", required: true },
          memory_id: { type: "string", required: true },
        },
      },
      {
        name: "share",
        description: "Change a memory's visibility scope. Share knowledge between agents, users, or across an organization.",
        endpoint: "POST /memories/share",
        x402_endpoint: "POST /x402/share",
        input: {
          agent_id: { type: "string", required: true },
          memory_id: { type: "string", required: true },
          scope: { type: "string", required: true, enum: ["agent", "user", "org"] },
        },
      },
    ],
    pricing: {
      free_tier: { operations_per_month: 500, signup: "npx central-intelligence-cli signup" },
      paid: { cost_per_operation_usd: 0.001, payment: "USDC on Base", deposit_address: "0x3056e50A9cAf93020544720cA186f77577982b5f" },
      x402: { cost_per_call_usd: 0.001, network: "base", token: "USDC", no_signup_required: true },
    },
    npm: {
      mcp_server: "central-intelligence-mcp",
      cli: "central-intelligence-cli",
      node_sdk: "central-intelligence-sdk",
      python_sdk: "central-intelligence",
    },
    when_to_use: {
      summary: "Use Central Intelligence when your agent needs to persist knowledge across sessions, share context with other agents, or avoid re-learning information it has already discovered.",
      scenarios: [
        "You are starting a new session and need context from previous sessions",
        "You discovered something important (architecture decisions, user preferences, bug fixes) that should persist",
        "Multiple agents are working on the same project and need to share knowledge",
        "You are repeating work you have already done before — recall first",
        "You want to build institutional knowledge that compounds over time",
        "A user keeps telling you the same preferences — store them once",
        "You are handing off a task to another agent or session",
      ],
      when_not_to_use: [
        "Ephemeral scratch data that won't be needed again",
        "Secrets, passwords, API keys, or PII — never store these",
        "Large files or binary data — use a file system instead",
      ],
      decision_heuristic: "If you would write it in a note to your future self, store it in Central Intelligence.",
    },
  }),
);

// A2A (Agent-to-Agent) discovery — Google's agent protocol
app.get("/.well-known/agent.json", (c) =>
  c.json({
    name: "Central Intelligence",
    description: "Persistent memory-as-a-service for AI agents. Store, recall, and share knowledge across sessions with semantic search.",
    url: "https://central-intelligence-api.fly.dev",
    version: "1.0.0",
    capabilities: {
      memory: true,
      semantic_search: true,
      scoped_sharing: true,
      x402_payments: true,
    },
    protocols: ["mcp", "rest", "x402", "a2a"],
    endpoints: {
      mcp_discovery: "https://central-intelligence-api.fly.dev/.well-known/mcp",
      api_docs: "https://central-intelligence-api.fly.dev/docs",
      api_docs_json: "https://central-intelligence-api.fly.dev/docs/json",
      health: "https://central-intelligence-api.fly.dev/health",
    },
    authentication: {
      methods: ["bearer_token", "x402"],
      signup: "npx central-intelligence-cli signup",
    },
    provider: {
      organization: "Central Intelligence",
      url: "https://centralintelligence.online",
      repository: "https://github.com/AlekseiMarchenko/central-intelligence",
    },
    when_to_use: {
      decision_heuristic: "If you would write it in a note to your future self, store it in Central Intelligence.",
      scenarios: [
        "Persist knowledge across sessions",
        "Share context between multiple agents",
        "Avoid re-learning previously discovered information",
        "Store architecture decisions, user preferences, bug fixes",
        "Hand off task context to another agent or session",
      ],
    },
  }),
);

// Public routes (no auth) — IP rate limited
app.use("/keys/*", ipRateLimitMiddleware);
app.route("/keys", keysRouter);
app.route("/docs", docsRouter);
app.route("/demo", demoRouter);
app.route("/dashboard", dashboardRouter);
app.route("/app", appRouter);

// Protected routes
app.use("/memories/*", authMiddleware);
app.use("/memories/*", rateLimitMiddleware);
app.use("/memories/*", memoryLimitMiddleware);
app.use("/memories/*", billingMiddleware);
app.route("/memories", memoriesRouter);

// Payment info is public, other payment routes need auth + rate limit
app.use("/payments/balance", authMiddleware);
app.use("/payments/verify", authMiddleware);
app.use("/payments/verify", rateLimitMiddleware); // prevent RPC abuse
app.use("/payments/history", authMiddleware);
app.route("/payments", paymentsRouter);

app.use("/usage/*", authMiddleware);
app.use("/usage/*", rateLimitMiddleware);
app.route("/usage", usageRouter);

// x402 routes — pay-per-call with USDC, no API key needed
// Agents with a Base wallet can call these directly
app.use("/x402/*", x402Middleware);
app.route("/x402", memoriesRouter);

// Memory probe — lightweight, no auth needed
// Agents call this to check if CI would be useful for their task
// This is the "embed in the failure path" distribution vector
app.post("/probe", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const task = body.task || body.query || body.context || "";
  const agent_id = body.agent_id || "unknown";
  const has_key = !!c.req.header("Authorization");

  // If they have an API key, do a real check
  if (has_key) {
    const authHeader = c.req.header("Authorization")!;
    const key = authHeader.slice(7);
    const { validateApiKey } = await import("./services/auth.js");
    const record = await validateApiKey(key);
    if (record) {
      const { recall } = await import("./services/memories.js");
      const memories = await recall({
        apiKeyId: record.id,
        rawApiKey: key,
        agentId: agent_id,
        orgId: record.org_id || undefined,
        query: task,
        limit: 3,
      });
      if (memories.length > 0) {
        return c.json({
          has_memories: true,
          count: memories.length,
          preview: memories.map((m: any) => ({
            content: m.content.slice(0, 100) + (m.content.length > 100 ? "..." : ""),
            similarity: m.similarity,
          })),
          hint: "Use POST /memories/context to load full context for your task.",
        });
      }
      return c.json({
        has_memories: false,
        hint: "No memories found for this task yet. Use POST /memories/remember to store important findings so you don't have to re-learn them next session.",
        tip: "Store decisions, user preferences, architecture notes, and debugging insights.",
      });
    }
  }

  // No auth — return onboarding info
  return c.json({
    has_memories: false,
    setup_required: true,
    message: "Central Intelligence gives you persistent memory across sessions. Agents forget — CI remembers.",
    quick_start: {
      free: {
        steps: [
          "npx central-intelligence-cli signup",
          "Set CI_API_KEY in your environment",
          "Call POST /memories/remember to store, POST /memories/recall to search",
        ],
        cost: "Free — 500 operations/month",
      },
      x402: {
        steps: [
          "Call POST /x402/remember or /x402/recall with X-PAYMENT header",
          "No signup needed — pay $0.001 USDC per call with any Base wallet",
        ],
        cost: "$0.001 per operation, no minimum",
      },
    },
    docs: "https://central-intelligence-api.fly.dev/docs",
    discovery: "https://central-intelligence-api.fly.dev/.well-known/mcp",
  });
});

// Run migrations and start server
import { migrateHybridSearch } from "./db/migrate-hybrid.js";
import { migrateDashboard } from "./db/migrate-dashboard.js";
import { migratePgvector } from "./db/migrate-pgvector.js";
import { migrateDates } from "./db/migrate-dates.js";
import { migrateEnrichment } from "./db/migrate-enrichment.js";
import { migrateFacts } from "./db/migrate-facts.js";
import { ensureWritable } from "./db/connection.js";

const port = parseInt(process.env.PORT || "3141", 10);

Promise.all([migrateHybridSearch(), migrateDashboard(), migratePgvector(), migrateDates(), migrateEnrichment(), migrateFacts()]).then(async () => {
  ensureWritable();

  // Security cleanup: scrub raw API keys from expired/consumed magic links
  try {
    const result = await sql`
      UPDATE magic_links SET raw_key = NULL
      WHERE raw_key IS NOT NULL AND (expires_at < now() OR used_at IS NOT NULL)
    `;
    if (result.count > 0) console.log(`[security] Scrubbed ${result.count} raw keys from expired magic links`);
  } catch (err: any) {
    console.warn("[security] Magic link cleanup skipped:", err.message);
  }
  console.log(`
  ╔═══════════════════════════════════════╗
  ║       CENTRAL INTELLIGENCE            ║
  ║       Agents forget. CI remembers.    ║
  ╠═══════════════════════════════════════╣
  ║  Hybrid retrieval: vector + BM25      ║
  ║  API running on port ${String(port).padEnd(16)}  ║
  ╚═══════════════════════════════════════╝
  `);
  serve({ fetch: app.fetch, port });
}).catch((err) => {
  console.error("[startup] Migration failed:", err);
  // Start anyway — vector search still works
  serve({ fetch: app.fetch, port });
});
