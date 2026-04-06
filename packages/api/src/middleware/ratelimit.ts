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
  free: 120,
  pro: 120,
  team: 600,
  enterprise: 3000,
};

// In-memory sliding window for API key rate limits
const windows = new Map<string, { count: number; resetAt: number }>();

// Periodic cleanup to prevent memory leaks from stale entries
setInterval(() => {
  const now = Date.now();
  for (const [key, window] of windows) {
    if (now > window.resetAt + 120_000) {
      windows.delete(key);
    }
  }
}, 60_000);

export async function rateLimitMiddleware(c: Context, next: Next) {
  const apiKeyId = c.get("apiKeyId") as string;
  const tier = (c.get("tier") as string) || "free";

  // Per-minute rate limit
  const rateLimit = RATE_LIMITS[tier] || RATE_LIMITS.free;
  const now = Date.now();
  const windowKey = `key:${apiKeyId}`;

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

// IP-based rate limiting for public endpoints (key creation)
// Strict: 5 key creations per hour per IP
const IP_RATE_LIMIT = 5;
const IP_WINDOW_MS = 60 * 60 * 1000; // 1 hour

export async function ipRateLimitMiddleware(c: Context, next: Next) {
  // On Fly.io, only trust fly-client-ip (set by Fly's proxy, not spoofable).
  // Fall back to x-forwarded-for only when NOT on Fly.io (local dev, other hosts).
  const ip = process.env.FLY_APP_NAME
    ? (c.req.header("fly-client-ip") || "unknown")
    : (c.req.header("fly-client-ip") ||
       c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
       c.req.header("x-real-ip") ||
       "unknown");

  const now = Date.now();
  const windowKey = `ip:${ip}`;

  let window = windows.get(windowKey);
  if (!window || now > window.resetAt) {
    window = { count: 0, resetAt: now + IP_WINDOW_MS };
    windows.set(windowKey, window);
  }

  window.count++;
  if (window.count > IP_RATE_LIMIT) {
    return c.json(
      { error: "Too many key creation requests. Try again later." },
      429,
    );
  }

  await next();
}
