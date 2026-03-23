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

// Public routes (no auth) — IP rate limited
app.use("/keys/*", ipRateLimitMiddleware);
app.route("/keys", keysRouter);
app.route("/docs", docsRouter);

// Protected routes
app.use("/memories/*", authMiddleware);
app.use("/memories/*", rateLimitMiddleware);
app.use("/memories/*", memoryLimitMiddleware);
app.route("/memories", memoriesRouter);

app.use("/usage/*", authMiddleware);
app.route("/usage", usageRouter);

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
