import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the database connection (hoisted to top level)
vi.mock("../src/db/connection.js", () => ({
  sql: vi.fn(),
}));

import { Hono } from "hono";

describe("rateLimitMiddleware", () => {
  let app: Hono;

  beforeEach(async () => {
    // Reset module cache to get fresh rate limit windows
    vi.resetModules();

    const { rateLimitMiddleware } = await import("../src/middleware/ratelimit.js");

    app = new Hono();

    // Simulate auth middleware setting context
    app.use("*", async (c, next) => {
      c.set("apiKeyId" as any, "test-key-id");
      c.set("tier" as any, "free");
      await next();
    });
    app.use("*", rateLimitMiddleware);
    app.get("/test", (c) => c.json({ ok: true }));
  });

  it("allows requests within rate limit", async () => {
    const res = await app.request("/test");
    expect(res.status).toBe(200);
    // Free tier limit dropped 120 → 60 in pricing-honesty pass (b70d187)
    // so the Pro tier's "120 req/min" feature is actually a 2× upgrade.
    expect(res.headers.get("X-RateLimit-Limit")).toBe("60");
    expect(parseInt(res.headers.get("X-RateLimit-Remaining") || "0")).toBeGreaterThan(0);
  });

  it("returns 429 when rate limit exceeded", async () => {
    // Exhaust the rate limit (free tier = 60/min after pricing-honesty pass)
    for (let i = 0; i < 60; i++) {
      await app.request("/test");
    }
    const res = await app.request("/test");
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toContain("Rate limit exceeded");
  });
});

describe("memoryLimitMiddleware", () => {
  it("passes through for non-remember endpoints", async () => {
    vi.resetModules();

    const { memoryLimitMiddleware } = await import("../src/middleware/ratelimit.js");

    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("apiKeyId" as any, "test-key-id");
      c.set("tier" as any, "free");
      await next();
    });
    app.use("*", memoryLimitMiddleware);
    app.post("/recall", (c) => c.json({ ok: true }));

    const res = await app.request("/recall", { method: "POST" });
    expect(res.status).toBe(200);
  });
});
