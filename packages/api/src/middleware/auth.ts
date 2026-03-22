import type { Context, Next } from "hono";
import { validateApiKey } from "../services/auth.js";

export async function authMiddleware(c: Context, next: Next) {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ error: "Missing or invalid Authorization header" }, 401);
  }

  const key = authHeader.slice(7);
  const record = await validateApiKey(key);
  if (!record) {
    return c.json({ error: "Invalid API key" }, 401);
  }

  c.set("apiKeyId", record.id);
  c.set("orgId", record.org_id);
  c.set("tier", record.tier);

  await next();
}
