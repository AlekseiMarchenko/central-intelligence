import { Hono } from "hono";
import { z } from "zod";
import * as memoriesService from "../services/memories.js";

type Env = {
  Variables: {
    apiKeyId: string;
    orgId: string | undefined;
    tier: string;
    rawApiKey: string;
  };
};

const app = new Hono<Env>();

// POST /memories/remember
const rememberSchema = z.object({
  agent_id: z.string().min(1).max(200),
  user_id: z.string().max(200).optional(),
  content: z.string().min(1).max(10000),
  scope: z.enum(["agent", "user", "org"]).default("agent"),
  tags: z.array(z.string().max(100)).max(20).default([]),
  event_date_from: z.string().optional(),
  event_date_to: z.string().optional(),
});

app.post("/remember", async (c) => {
  const body = await c.req.json();
  const parsed = rememberSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid request", details: parsed.error.issues }, 400);
  }

  const { agent_id, user_id, content, scope, tags, event_date_from, event_date_to } = parsed.data;
  const apiKeyId = c.get("apiKeyId");
  const orgId = c.get("orgId");
  const rawApiKey = c.get("rawApiKey");

  try {
    const memory = await memoriesService.store({
      apiKeyId,
      rawApiKey,
      agentId: agent_id,
      userId: user_id,
      orgId,
      scope,
      content,
      tags,
      eventDateFrom: event_date_from,
      eventDateTo: event_date_to,
    });

    return c.json({ memory }, 201);
  } catch (err: any) {
    console.error("Remember error:", err?.message || err);
    return c.json({ error: "Failed to store memory" }, 500);
  }
});

// POST /memories/recall
const recallSchema = z.object({
  agent_id: z.string().min(1).max(200),
  user_id: z.string().max(200).optional(),
  query: z.string().min(1).max(5000),
  scope: z.enum(["agent", "user", "org"]).optional(),
  tags: z.array(z.string().max(100)).max(20).optional(),
  limit: z.number().int().min(1).max(50).default(10),
  date_from: z.string().optional(),
  date_to: z.string().optional(),
});

app.post("/recall", async (c) => {
  const body = await c.req.json();
  const parsed = recallSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid request", details: parsed.error.issues }, 400);
  }

  const { agent_id, user_id, query, scope, tags, limit, date_from, date_to } = parsed.data;
  const apiKeyId = c.get("apiKeyId");
  const orgId = c.get("orgId");
  const rawApiKey = c.get("rawApiKey");

  try {
    const memories = await memoriesService.recall({
      apiKeyId,
      rawApiKey,
      agentId: agent_id,
      userId: user_id,
      orgId,
      query,
      scope,
      tags,
      limit,
      dateFrom: date_from,
      dateTo: date_to,
    });

    return c.json({ memories });
  } catch (err: any) {
    console.error("Recall error:", err?.message || err);
    return c.json({ error: "Failed to recall memories" }, 500);
  }
});

// POST /memories/context
const contextSchema = z.object({
  agent_id: z.string().min(1).max(200),
  user_id: z.string().max(200).optional(),
  current_context: z.string().min(1).max(5000),
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
  const rawApiKey = c.get("rawApiKey");

  // Recall with broader scope to get max context
  const memories = await memoriesService.recall({
    apiKeyId,
    rawApiKey,
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

// POST /memories/extract — trigger fact extraction for all pending memories
app.post("/extract", async (c) => {
  const apiKeyId = c.get("apiKeyId");
  const rawApiKey = c.get("rawApiKey");

  try {
    const result = await memoriesService.processPendingMemories(apiKeyId, rawApiKey);
    return c.json(result);
  } catch (err: any) {
    console.error("Extract error:", err?.message || err);
    return c.json({ error: "Failed to process pending memories" }, 500);
  }
});

export { app as memoriesRouter };
