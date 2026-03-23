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
import { paymentsRouter } from "./routes/payments.js";
import { billingMiddleware } from "./middleware/billing.js";
import { x402Middleware } from "./middleware/x402.js";

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
      if (!origin) return "*";
      // Allow configured origins
      if (ALLOWED_ORIGINS.includes(origin)) return origin;
      // Allow localhost for development
      if (origin.startsWith("http://localhost:")) return origin;
      // Block all others
      return "";
    },
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
    version: "0.1.0",
    docs: "/docs",
  }),
);

app.get("/health", (c) => c.json({ status: "ok" }));

// MCP discovery — agents look for this automatically
app.get("/.well-known/mcp", (c) =>
  c.json({
    name: "Central Intelligence",
    description: "Persistent memory for AI agents. Store, recall, and share knowledge across sessions.",
    version: "0.2.0",
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
    },
  }),
);

// A2A (Agent-to-Agent) discovery — Google's agent protocol
app.get("/.well-known/agent.json", (c) =>
  c.json({
    name: "Central Intelligence",
    description: "Persistent memory-as-a-service for AI agents. Store, recall, and share knowledge across sessions with semantic search.",
    url: "https://central-intelligence-api.fly.dev",
    version: "0.2.0",
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
  }),
);

// Public routes (no auth) — IP rate limited
app.use("/keys/*", ipRateLimitMiddleware);
app.route("/keys", keysRouter);
app.route("/docs", docsRouter);
app.route("/dashboard", dashboardRouter);

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
app.route("/usage", usageRouter);

// x402 routes — pay-per-call with USDC, no API key needed
// Agents with a Base wallet can call these directly
app.use("/x402/*", x402Middleware);
app.route("/x402", memoriesRouter);

// Start server
const port = parseInt(process.env.PORT || "3141", 10);
console.log(`
  ╔═══════════════════════════════════════╗
  ║       CENTRAL INTELLIGENCE            ║
  ║       Agents forget. CI remembers.    ║
  ╠═══════════════════════════════════════╣
  ║  API running on port ${String(port).padEnd(16)}  ║
  ╚═══════════════════════════════════════╝
`);

serve({ fetch: app.fetch, port });
