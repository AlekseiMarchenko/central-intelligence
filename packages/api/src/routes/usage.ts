import { Hono } from "hono";
import { sql } from "../db/connection.js";

const app = new Hono();

// GET /usage — usage stats for current API key
app.get("/", async (c) => {
  const apiKeyId = c.get("apiKeyId");

  // Memory count by scope
  const memoryCounts = await sql`
    SELECT scope, COUNT(*)::int AS count
    FROM memories
    WHERE api_key_id = ${apiKeyId} AND deleted_at IS NULL
    GROUP BY scope
  `;

  // Total memories
  const [{ total }] = await sql`
    SELECT COUNT(*)::int AS total
    FROM memories
    WHERE api_key_id = ${apiKeyId} AND deleted_at IS NULL
  `;

  // Usage events in last 30 days
  const eventCounts = await sql`
    SELECT event_type, COUNT(*)::int AS count, SUM(tokens)::int AS total_tokens
    FROM usage_events
    WHERE api_key_id = ${apiKeyId}
      AND created_at > now() - interval '30 days'
    GROUP BY event_type
  `;

  // Daily usage for last 7 days
  const dailyUsage = await sql`
    SELECT
      date_trunc('day', created_at)::date AS date,
      COUNT(*)::int AS events,
      SUM(tokens)::int AS tokens
    FROM usage_events
    WHERE api_key_id = ${apiKeyId}
      AND created_at > now() - interval '7 days'
    GROUP BY date
    ORDER BY date
  `;

  // Active agents
  const agents = await sql`
    SELECT DISTINCT agent_id
    FROM memories
    WHERE api_key_id = ${apiKeyId} AND deleted_at IS NULL
  `;

  return c.json({
    memories: {
      total,
      by_scope: Object.fromEntries(
        (memoryCounts as unknown as Array<{ scope: string; count: number }>).map(
          (r) => [r.scope, r.count],
        ),
      ),
    },
    events_30d: Object.fromEntries(
      (
        eventCounts as unknown as Array<{
          event_type: string;
          count: number;
          total_tokens: number;
        }>
      ).map((r) => [r.event_type, { count: r.count, tokens: r.total_tokens }]),
    ),
    daily_usage_7d: dailyUsage,
    active_agents: (agents as unknown as Array<{ agent_id: string }>).map(
      (a) => a.agent_id,
    ),
  });
});

export { app as usageRouter };
