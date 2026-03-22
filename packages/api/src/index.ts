import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { serve } from "@hono/node-server";
import { authMiddleware } from "./middleware/auth.js";
import { rateLimitMiddleware, memoryLimitMiddleware } from "./middleware/ratelimit.js";
import { memoriesRouter } from "./routes/memories.js";
import { keysRouter } from "./routes/keys.js";
import { usageRouter } from "./routes/usage.js";
import { docsRouter } from "./routes/docs.js";

const app = new Hono();

// Global middleware
app.use("*", cors());
app.use("*", logger());

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

// Public routes (no auth)
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
