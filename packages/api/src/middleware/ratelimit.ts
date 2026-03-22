import type { Context, Next } from "hono";
import { sql } from "../db/connection.js";

// Tier limits (memories per month)
const TIER_LIMITS: Record<string, number> = {
  free: 500,
  pro: 50_000,
  team: 500_000,
  enterprise: Infinity,
};

// Per-minute rate limits (API calls)
const RATE_LIMITS: Record<string, number> = {
  free: 30,
  pro: 120,
  team: 600,
  enterprise: 3000,
};

// In-memory sliding window (resets on restart — good enough for MVP)
const windows = new Map<string, { count: number; resetAt: number }>();

export async function rateLimitMiddleware(c: Context, next: Next) {
  const apiKeyId = c.get("apiKeyId") as string;
  const tier = (c.get("tier") as string) || "free";

  // Per-minute rate limit
  const rateLimit = RATE_LIMITS[tier] || RATE_LIMITS.free;
  const now = Date.now();
  const windowKey = apiKeyId;

  let window = windows.get(windowKey);
  if (!window || now > window.resetAt) {
    window = { count: 0, resetAt: now + 60_000 };
    windows.set(windowKey, window);
  }

  window.count++;
  if (window.count > rateLimit) {
    c.header("X-RateLimit-Limit", String(rateLimit));
    c.header("X-RateLimit-Remaining", "0");
    c.header(
      "X-RateLimit-Reset",
      String(Math.ceil(window.resetAt / 1000)),
    );
    return c.json(
      { error: "Rate limit exceeded. Upgrade your plan for higher limits." },
      429,
    );
  }

  c.header("X-RateLimit-Limit", String(rateLimit));
  c.header(
    "X-RateLimit-Remaining",
    String(Math.max(0, rateLimit - window.count)),
  );

  await next();
}

export async function memoryLimitMiddleware(c: Context, next: Next) {
  // Only check on remember (store) operations
  if (!c.req.path.endsWith("/remember")) {
    await next();
    return;
  }

  const apiKeyId = c.get("apiKeyId") as string;
  const tier = (c.get("tier") as string) || "free";
  const limit = TIER_LIMITS[tier] || TIER_LIMITS.free;

  if (limit === Infinity) {
    await next();
    return;
  }

  const [{ count }] = await sql`
    SELECT COUNT(*)::int AS count
    FROM memories
    WHERE api_key_id = ${apiKeyId} AND deleted_at IS NULL
  `;

  if (count >= limit) {
    return c.json(
      {
        error: `Memory limit reached (${count}/${limit}). Upgrade your plan or forget old memories.`,
        current: count,
        limit,
        tier,
      },
      403,
    );
  }

  c.header("X-Memory-Usage", `${count}/${limit}`);
  await next();
}
