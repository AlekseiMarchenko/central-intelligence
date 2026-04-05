import { Hono } from "hono";
import { z } from "zod";
import { sql } from "../db/connection.js";
import { createHash, randomBytes } from "crypto";
import { generateApiKey, hashKey, validateApiKey } from "../services/auth.js";
import { sendMagicLink, sendWelcomeLink } from "../services/email.js";
import * as memoriesService from "../services/memories.js";

const app = new Hono();

const MAGIC_LINK_TTL = 15 * 60 * 1000; // 15 minutes
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days

// --- Helpers ---

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

async function getSessionUser(c: any): Promise<{ apiKeyId: string; email: string; tier: string } | null> {
  // Read session token from Authorization: Bearer header (cross-origin safe)
  const authHeader = c.req.header("Authorization") || "";
  const sessionToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!sessionToken) return null;

  const hash = hashToken(sessionToken);
  const [row] = await sql`
    SELECT ds.api_key_id, ak.email, ak.tier
    FROM dashboard_sessions ds
    JOIN api_keys ak ON ak.id = ds.api_key_id
    WHERE ds.session_hash = ${hash}
      AND ds.expires_at > now()
      AND ak.revoked_at IS NULL
  `;
  if (!row) return null;
  return {
    apiKeyId: (row as any).api_key_id,
    email: (row as any).email,
    tier: (row as any).tier,
  };
}

// Rate limit: max 5 magic link requests per email per hour (in-memory)
const linkRateLimit = new Map<string, number[]>();
function checkLinkRateLimit(email: string): boolean {
  const now = Date.now();
  const key = email.toLowerCase();
  const times = (linkRateLimit.get(key) || []).filter(t => now - t < 3600_000);
  if (times.length >= 5) return false;
  times.push(now);
  linkRateLimit.set(key, times);
  return true;
}

// Clean rate limit map periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, times] of linkRateLimit) {
    const valid = times.filter(t => now - t < 3600_000);
    if (valid.length === 0) linkRateLimit.delete(key);
    else linkRateLimit.set(key, valid);
  }
}, 300_000);

// =====================
// AUTH ROUTES
// =====================

// POST /app/auth/signup — new user: create account + send magic link
const signupSchema = z.object({
  email: z.string().email().max(200),
});

app.post("/auth/signup", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = signupSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: "Valid email required" }, 400);

  const email = parsed.data.email.toLowerCase();

  if (!checkLinkRateLimit(email)) {
    return c.json({ error: "Too many requests. Try again in an hour." }, 429);
  }

  // Check if email already exists
  const [existing] = await sql`
    SELECT id FROM api_keys WHERE email = ${email} AND revoked_at IS NULL
  `;
  if (existing) {
    // Email already registered — send sign-in link instead (don't reveal existence)
    const token = randomBytes(32).toString("base64url");
    await sql`
      INSERT INTO magic_links (api_key_id, email, token_hash, expires_at)
      VALUES (${(existing as any).id}, ${email}, ${hashToken(token)}, ${new Date(Date.now() + MAGIC_LINK_TTL)})
    `;
    await sendMagicLink(email, token);
    return c.json({ ok: true, message: "Check your email for a sign-in link." });
  }

  // Create new account
  const { key, hash, prefix } = generateApiKey();
  const [newKey] = await sql`
    INSERT INTO api_keys (key_hash, key_prefix, name, email)
    VALUES (${hash}, ${prefix}, ${"dashboard"}, ${email})
    RETURNING id
  `;
  const apiKeyId = (newKey as any).id;

  // Create magic link (store raw key for one-time reveal on first login)
  const token = randomBytes(32).toString("base64url");
  await sql`
    INSERT INTO magic_links (api_key_id, email, token_hash, expires_at, raw_key)
    VALUES (${apiKeyId}, ${email}, ${hashToken(token)}, ${new Date(Date.now() + MAGIC_LINK_TTL)}, ${key})
  `;

  await sendWelcomeLink(email, token, key);
  return c.json({ ok: true, message: "Check your email to get started." }, 201);
});

// POST /app/auth/send-link — existing user: send magic link
app.post("/auth/send-link", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = signupSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: "Valid email required" }, 400);

  const email = parsed.data.email.toLowerCase();

  if (!checkLinkRateLimit(email)) {
    return c.json({ error: "Too many requests. Try again in an hour." }, 429);
  }

  // Always return success (don't reveal if email exists)
  const [record] = await sql`
    SELECT id FROM api_keys WHERE email = ${email} AND revoked_at IS NULL
  `;

  if (record) {
    const token = randomBytes(32).toString("base64url");
    await sql`
      INSERT INTO magic_links (api_key_id, email, token_hash, expires_at)
      VALUES (${(record as any).id}, ${email}, ${hashToken(token)}, ${new Date(Date.now() + MAGIC_LINK_TTL)})
    `;
    await sendMagicLink(email, token);
  }

  return c.json({ ok: true, message: "If that email is registered, you'll receive a sign-in link." });
});

// POST /app/auth/link-key — link existing API key to email
const linkKeySchema = z.object({
  email: z.string().email().max(200),
  api_key: z.string().min(1).max(200),
});

app.post("/auth/link-key", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = linkKeySchema.safeParse(body);
  if (!parsed.success) return c.json({ error: "Valid email and API key required" }, 400);

  const email = parsed.data.email.toLowerCase();
  const apiKey = parsed.data.api_key;

  if (!checkLinkRateLimit(email)) {
    return c.json({ error: "Too many requests. Try again in an hour." }, 429);
  }

  // Validate the API key
  const record = await validateApiKey(apiKey);
  if (!record) {
    return c.json({ error: "Invalid API key" }, 401);
  }

  // Check email not already used by another key
  const [emailUsed] = await sql`
    SELECT id FROM api_keys WHERE email = ${email} AND id != ${record.id} AND revoked_at IS NULL
  `;
  if (emailUsed) {
    return c.json({ error: "This email is already linked to another account" }, 409);
  }

  // Link email to key
  await sql`UPDATE api_keys SET email = ${email} WHERE id = ${record.id}`;

  // Send magic link
  const token = randomBytes(32).toString("base64url");
  await sql`
    INSERT INTO magic_links (api_key_id, email, token_hash, expires_at)
    VALUES (${record.id}, ${email}, ${hashToken(token)}, ${new Date(Date.now() + MAGIC_LINK_TTL)})
  `;
  await sendMagicLink(email, token);

  return c.json({ ok: true, message: "Email linked. Check your inbox for a sign-in link." });
});

// POST /app/auth/verify — exchange magic link token for session
const verifySchema = z.object({
  token: z.string().min(1).max(200),
});

app.post("/auth/verify", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = verifySchema.safeParse(body);
  if (!parsed.success) return c.json({ error: "Token required" }, 400);

  const tokenHash = hashToken(parsed.data.token);

  // Find and consume magic link
  const [link] = await sql`
    UPDATE magic_links
    SET used_at = now()
    WHERE token_hash = ${tokenHash}
      AND expires_at > now()
      AND used_at IS NULL
    RETURNING api_key_id, email, raw_key
  `;

  if (!link) {
    return c.json({ error: "Invalid or expired link. Request a new one." }, 401);
  }

  // Create session
  const sessionToken = randomBytes(32).toString("base64url");
  const sessionHash = hashToken(sessionToken);
  const expiresAt = new Date(Date.now() + SESSION_TTL);

  await sql`
    INSERT INTO dashboard_sessions (api_key_id, session_hash, expires_at)
    VALUES (${(link as any).api_key_id}, ${sessionHash}, ${expiresAt})
  `;

  // Return token (stored in localStorage by SPA — cross-origin safe)
  // Include raw API key if this was a new signup (one-time reveal)
  const response: any = { ok: true, email: (link as any).email, session_token: sessionToken };
  if ((link as any).raw_key) {
    response.api_key = (link as any).raw_key;
    // Clear the raw key from DB after reveal
    await sql`UPDATE magic_links SET raw_key = NULL WHERE token_hash = ${tokenHash}`;
  }
  return c.json(response);
});

// POST /app/auth/logout
app.post("/auth/logout", async (c) => {
  const authHeader = c.req.header("Authorization") || "";
  const sessionToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (sessionToken) {
    const hash = hashToken(sessionToken);
    await sql`DELETE FROM dashboard_sessions WHERE session_hash = ${hash}`;
  }
  return c.json({ ok: true });
});

// GET /app/auth/me — current user info
app.get("/auth/me", async (c) => {
  const user = await getSessionUser(c);
  if (!user) return c.json({ error: "Not signed in" }, 401);

  // Get memory count and limit
  const [stats] = await sql`
    SELECT
      COUNT(*)::int AS memory_count,
      COUNT(DISTINCT agent_id)::int AS agent_count
    FROM memories
    WHERE api_key_id = ${user.apiKeyId} AND deleted_at IS NULL
  `;

  const memoryLimit = user.tier === "free" ? 500 : user.tier === "pro" ? 10000 : 100000;

  return c.json({
    email: user.email,
    tier: user.tier,
    memory_count: (stats as any).memory_count,
    agent_count: (stats as any).agent_count,
    memory_limit: memoryLimit,
  });
});

// POST /app/auth/new-key — generate a fresh API key for the account
app.post("/auth/new-key", async (c) => {
  const user = await getSessionUser(c);
  if (!user) return c.json({ error: "Not signed in" }, 401);

  // Revoke all existing keys for this account
  await sql`UPDATE api_keys SET revoked_at = now() WHERE id = ${user.apiKeyId}`;

  // Generate new key linked to same email
  const { key, hash, prefix } = generateApiKey();
  const [newKey] = await sql`
    INSERT INTO api_keys (key_hash, key_prefix, name, email)
    VALUES (${hash}, ${prefix}, ${"dashboard"}, ${user.email})
    RETURNING id
  `;

  // Update the session to point to the new key
  const authHeader = c.req.header("Authorization") || "";
  const sessionToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (sessionToken) {
    const sessionHash = hashToken(sessionToken);
    await sql`UPDATE dashboard_sessions SET api_key_id = ${(newKey as any).id} WHERE session_hash = ${sessionHash}`;
  }

  return c.json({ ok: true, api_key: key });
});

// =====================
// DATA ROUTES (session-protected)
// =====================

// GET /app/api/memories — list memories (paginated)
app.get("/api/memories", async (c) => {
  const user = await getSessionUser(c);
  if (!user) return c.json({ error: "Not signed in" }, 401);

  const page = Math.max(1, parseInt(c.req.query("page") || "1", 10));
  const limit = Math.min(100, Math.max(1, parseInt(c.req.query("limit") || "50", 10)));
  const offset = (page - 1) * limit;
  const tag = c.req.query("tag");

  let memories;
  let total: number;

  if (tag) {
    memories = await sql`
      SELECT id, agent_id, user_id, scope, content, tags, created_at, updated_at
      FROM memories
      WHERE api_key_id = ${user.apiKeyId} AND deleted_at IS NULL AND ${tag} = ANY(tags)
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
    const [countRow] = await sql`
      SELECT COUNT(*)::int AS count FROM memories
      WHERE api_key_id = ${user.apiKeyId} AND deleted_at IS NULL AND ${tag} = ANY(tags)
    `;
    total = (countRow as any).count;
  } else {
    memories = await sql`
      SELECT id, agent_id, user_id, scope, content, tags, created_at, updated_at
      FROM memories
      WHERE api_key_id = ${user.apiKeyId} AND deleted_at IS NULL
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
    const [countRow] = await sql`
      SELECT COUNT(*)::int AS count FROM memories
      WHERE api_key_id = ${user.apiKeyId} AND deleted_at IS NULL
    `;
    total = (countRow as any).count;
  }

  // Decrypt content using the raw API key from X-CI-Key header
  const rawKey = c.req.header("X-CI-Key") || "";
  const { decrypt, isEncrypted } = await import("../services/encryption.js");
  const decrypted = (memories as any[]).map((m) => {
    try {
      if (isEncrypted(m.content) && rawKey) {
        return { ...m, content: decrypt(m.content, rawKey) };
      }
      return m;
    } catch {
      return m;
    }
  });

  return c.json({
    memories: decrypted,
    page,
    limit,
    total,
    pages: Math.ceil(total / limit),
  });
});

// GET /app/api/memories/search — hybrid search
app.get("/api/memories/search", async (c) => {
  const user = await getSessionUser(c);
  if (!user) return c.json({ error: "Not signed in" }, 401);

  const query = c.req.query("q") || "";
  const mode = c.req.query("mode") || "smart";
  const limit = Math.min(50, Math.max(1, parseInt(c.req.query("limit") || "20", 10)));

  if (!query) {
    return c.json({ memories: [], query: "", mode });
  }

  const rawKey = c.req.header("X-CI-Key") || "";
  const { decrypt: dec, isEncrypted: isEnc } = await import("../services/encryption.js");
  function decryptMemories(mems: any[]) {
    return mems.map(m => {
      try { return isEnc(m.content) && rawKey ? { ...m, content: dec(m.content, rawKey) } : m; }
      catch { return m; }
    });
  }

  if (mode === "keyword") {
    // Simple keyword search via ILIKE (works on encrypted content too if not encrypted)
    const pattern = `%${query}%`;
    const memories = await sql`
      SELECT id, agent_id, user_id, scope, content, tags, created_at, updated_at
      FROM memories
      WHERE api_key_id = ${user.apiKeyId}
        AND deleted_at IS NULL
        AND content ILIKE ${pattern}
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;
    return c.json({ memories: decryptMemories(memories as any[]), query, mode });
  }

  // Smart mode: use the existing recall service
  // We need the raw API key for decryption — use a simplified search without it
  // For now, do BM25 full-text search which works on tsvector
  const tsQuery = query.split(/\s+/).filter(Boolean).join(" & ");
  const memories = await sql`
    SELECT id, agent_id, user_id, scope, content, tags, created_at, updated_at,
      ts_rank(content_tsv, to_tsquery('english', ${tsQuery})) AS rank
    FROM memories
    WHERE api_key_id = ${user.apiKeyId}
      AND deleted_at IS NULL
      AND content_tsv @@ to_tsquery('english', ${tsQuery})
    ORDER BY rank DESC
    LIMIT ${limit}
  `;

  return c.json({ memories: decryptMemories(memories as any[]), query, mode });
});

// POST /app/api/memories/delete — soft-delete memories
const deleteSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(50),
});

app.post("/api/memories/delete", async (c) => {
  const user = await getSessionUser(c);
  if (!user) return c.json({ error: "Not signed in" }, 401);

  const body = await c.req.json().catch(() => ({}));
  const parsed = deleteSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: "Provide an array of memory IDs" }, 400);

  const result = await sql`
    UPDATE memories
    SET deleted_at = now()
    WHERE api_key_id = ${user.apiKeyId}
      AND id = ANY(${parsed.data.ids}::uuid[])
      AND deleted_at IS NULL
  `;

  return c.json({ deleted: (result as any).count || 0, requested: parsed.data.ids.length });
});

// GET /app/api/memories/tags — unique tags with counts
app.get("/api/memories/tags", async (c) => {
  const user = await getSessionUser(c);
  if (!user) return c.json({ error: "Not signed in" }, 401);

  const tags = await sql`
    SELECT unnest(tags) AS tag, COUNT(*)::int AS count
    FROM memories
    WHERE api_key_id = ${user.apiKeyId}
      AND deleted_at IS NULL
      AND array_length(tags, 1) > 0
    GROUP BY tag
    ORDER BY count DESC
    LIMIT 50
  `;

  return c.json({ tags });
});

// GET /app/api/memories/stats — summary stats with health score
app.get("/api/memories/stats", async (c) => {
  const user = await getSessionUser(c);
  if (!user) return c.json({ error: "Not signed in" }, 401);

  const [stats] = await sql`
    SELECT
      COUNT(*)::int AS total,
      COUNT(DISTINCT agent_id)::int AS agents,
      COUNT(DISTINCT COALESCE(scope, 'agent'))::int AS scopes,
      COUNT(*) FILTER (WHERE created_at < now() - interval '90 days')::int AS stale_count
    FROM memories
    WHERE api_key_id = ${user.apiKeyId} AND deleted_at IS NULL
  `;

  const scopeBreakdown = await sql`
    SELECT scope, COUNT(*)::int AS count
    FROM memories
    WHERE api_key_id = ${user.apiKeyId} AND deleted_at IS NULL
    GROUP BY scope ORDER BY count DESC
  `;

  const agentList = await sql`
    SELECT agent_id, COUNT(*)::int AS memories, MAX(created_at) AS last_active
    FROM memories
    WHERE api_key_id = ${user.apiKeyId} AND deleted_at IS NULL
    GROUP BY agent_id ORDER BY memories DESC LIMIT 20
  `;

  // Compute health score (0-10)
  const total = (stats as any).total;
  const staleCount = (stats as any).stale_count;
  let health = 10;
  health -= Math.floor(staleCount / 10); // -1 per 10 stale
  if (total > 500) health -= 1; // bloat penalty
  health = Math.max(0, Math.min(10, health));

  const memoryLimit = user.tier === "free" ? 500 : user.tier === "pro" ? 10000 : 100000;

  return c.json({
    total,
    agents: (stats as any).agents,
    stale_count: staleCount,
    health,
    memory_limit: memoryLimit,
    tier: user.tier,
    scope_breakdown: scopeBreakdown,
    agent_list: agentList,
  });
});

// GET /app/api/memories/duplicates — find duplicate memories (Jaccard word similarity > 0.8)
app.get("/api/memories/duplicates", async (c) => {
  const user = await getSessionUser(c);
  if (!user) return c.json({ error: "Not signed in" }, 401);

  const rawKey = c.req.header("X-CI-Key") || "";
  const { decrypt: dec, isEncrypted: isEnc } = await import("../services/encryption.js");

  // Fetch all memories (content only, limit to 500 for performance)
  const allMems = await sql`
    SELECT id, agent_id, scope, content, tags, created_at
    FROM memories
    WHERE api_key_id = ${user.apiKeyId} AND deleted_at IS NULL
    ORDER BY created_at DESC
    LIMIT 500
  `;

  // Decrypt content
  const mems = (allMems as any[]).map(m => {
    try {
      const content = isEnc(m.content) && rawKey ? dec(m.content, rawKey) : m.content;
      return { ...m, content };
    } catch { return m; }
  });

  // Tokenize each memory
  function tokenize(text: string): Set<string> {
    return new Set(
      text.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 2)
    );
  }

  function jaccard(a: Set<string>, b: Set<string>): number {
    let intersection = 0;
    for (const w of a) { if (b.has(w)) intersection++; }
    const union = a.size + b.size - intersection;
    return union === 0 ? 0 : intersection / union;
  }

  // Find duplicate groups
  const tokens = mems.map(m => tokenize(m.content));
  const dupOf = new Map<number, number>(); // index -> group leader index

  for (let i = 0; i < mems.length; i++) {
    if (dupOf.has(i)) continue;
    for (let j = i + 1; j < mems.length; j++) {
      if (dupOf.has(j)) continue;
      if (jaccard(tokens[i], tokens[j]) > 0.8) {
        dupOf.set(j, dupOf.get(i) ?? i);
        if (!dupOf.has(i)) dupOf.set(i, i);
      }
    }
  }

  // Build groups
  const groups = new Map<number, any[]>();
  for (const [idx, leader] of dupOf) {
    if (!groups.has(leader)) groups.set(leader, [mems[leader]]);
    if (idx !== leader) groups.get(leader)!.push(mems[idx]);
  }

  // Flatten: return all duplicate memories with their group ID
  const duplicates: any[] = [];
  let groupId = 0;
  for (const [, members] of groups) {
    groupId++;
    for (const m of members) {
      duplicates.push({ ...m, duplicate_group: `dup-${groupId}` });
    }
  }

  return c.json({
    duplicates,
    group_count: groups.size,
    total_duplicates: duplicates.length,
  });
});

export { app as appRouter };
