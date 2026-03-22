import { Hono } from "hono";
import { z } from "zod";
import * as memoriesService from "../services/memories.js";

const app = new Hono();

// POST /memories/remember
const rememberSchema = z.object({
  agent_id: z.string().min(1),
  user_id: z.string().optional(),
  content: z.string().min(1).max(10000),
  scope: z.enum(["agent", "user", "org"]).default("agent"),
  tags: z.array(z.string()).default([]),
});

app.post("/remember", async (c) => {
  const body = await c.req.json();
  const parsed = rememberSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid request", details: parsed.error.issues }, 400);
  }

  const { agent_id, user_id, content, scope, tags } = parsed.data;
  const apiKeyId = c.get("apiKeyId");
  const orgId = c.get("orgId");

  const memory = await memoriesService.store({
    apiKeyId,
    agentId: agent_id,
    userId: user_id,
    orgId,
    scope,
    content,
    tags,
  });

  return c.json({ memory }, 201);
});

// POST /memories/recall
const recallSchema = z.object({
  agent_id: z.string().min(1),
  user_id: z.string().optional(),
  query: z.string().min(1),
  scope: z.enum(["agent", "user", "org"]).optional(),
  tags: z.array(z.string()).optional(),
  limit: z.number().int().min(1).max(50).default(10),
});

app.post("/recall", async (c) => {
  const body = await c.req.json();
  const parsed = recallSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid request", details: parsed.error.issues }, 400);
  }

  const { agent_id, user_id, query, scope, tags, limit } = parsed.data;
  const apiKeyId = c.get("apiKeyId");
  const orgId = c.get("orgId");

  const memories = await memoriesService.recall({
    apiKeyId,
    agentId: agent_id,
    userId: user_id,
    orgId,
    query,
    scope,
    tags,
    limit,
  });

  return c.json({ memories });
});

// POST /memories/context
const contextSchema = z.object({
  agent_id: z.string().min(1),
  user_id: z.string().optional(),
  current_context: z.string().min(1),
  max_memories: z.number().int().min(1).max(20).default(5),
});

app.post("/context", async (c) => {
  const body = await c.req.json();
  const parsed = contextSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid request", details: parsed.error.issues }, 400);
  }

  const { agent_id, user_id, current_context, max_memories } = parsed.data;
  const apiKeyId = c.get("apiKeyId");
  const orgId = c.get("orgId");

  // Recall with broader scope to get max context
  const memories = await memoriesService.recall({
    apiKeyId,
    agentId: agent_id,
    userId: user_id,
    orgId,
    query: current_context,
    scope: orgId ? "org" : user_id ? "user" : "agent",
    limit: max_memories,
  });

  return c.json({ memories });
});

// DELETE /memories/:id
app.delete("/:id", async (c) => {
  const memoryId = c.req.param("id");
  const apiKeyId = c.get("apiKeyId");

  const deleted = await memoriesService.forget(apiKeyId, memoryId);
  if (!deleted) {
    return c.json({ error: "Memory not found" }, 404);
  }

  return c.json({ deleted: true });
});

// POST /memories/:id/share
const shareSchema = z.object({
  target_scope: z.enum(["user", "org"]),
  user_id: z.string().optional(),
});

app.post("/:id/share", async (c) => {
  const memoryId = c.req.param("id");
  const apiKeyId = c.get("apiKeyId");
  const orgId = c.get("orgId");
  const body = await c.req.json();
  const parsed = shareSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid request", details: parsed.error.issues }, 400);
  }

  const { target_scope, user_id } = parsed.data;

  if (target_scope === "org" && !orgId) {
    return c.json({ error: "No organization associated with this API key" }, 400);
  }

  const shared = await memoriesService.share(
    apiKeyId,
    memoryId,
    target_scope,
    user_id,
    orgId,
  );

  if (!shared) {
    return c.json({ error: "Memory not found" }, 404);
  }

  return c.json({ shared: true });
});

export { app as memoriesRouter };
