#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const API_BASE = process.env.CI_API_URL || "https://central-intelligence-api.fly.dev";
const API_KEY = process.env.CI_API_KEY || "";

if (!API_KEY) {
  console.error(
    "CI_API_KEY not set. Get one at https://centralintelligence.online or run: npx central-intelligence-cli signup",
  );
  process.exit(1);
}

// --- API client ---

async function apiCall(
  path: string,
  method: "GET" | "POST" | "DELETE",
  body?: Record<string, unknown>,
): Promise<unknown> {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(
      `CI API error (${res.status}): ${(err as Record<string, string>).error || res.statusText}`,
    );
  }

  return res.json();
}

// --- MCP Server ---

const server = new McpServer({
  name: "central-intelligence",
  version: "1.0.0",
});

// Tool 1: remember
server.tool(
  "remember",
  `Store a fact, decision, or preference in persistent memory so it survives across sessions. This is a write operation that creates a new memory record, encrypts the content at rest, and generates a vector embedding for semantic search. Use remember (not recall) when you learn something worth keeping: architecture decisions, user preferences, bug root causes, project conventions, or task outcomes. Do not use for ephemeral scratch data, secrets, or large files. Returns the memory ID and timestamp. Costs 1 operation against the API key's monthly quota (500 free, then paid). Use forget to delete outdated memories before storing corrections, to prevent contradictions.`,
  {
    content: z
      .string()
      .describe(
        "The information to store. Write as a complete, self-contained statement (not fragments). Include context: 'User prefers TypeScript for backend services' not just 'TypeScript'. Max 10,000 characters.",
      ),
    agent_id: z
      .string()
      .default("default")
      .describe("Unique identifier for this agent instance. Use a consistent value across sessions so memories are retrievable. Default: 'default'."),
    user_id: z
      .string()
      .optional()
      .describe("User identifier, required when scope is 'user'. Links the memory to a specific user across all their agents."),
    tags: z
      .array(z.string())
      .default([])
      .describe(
        "Categorical labels for filtering during recall. Use lowercase, consistent terms: 'preference', 'decision', 'architecture', 'bug-fix'. Max 20 tags, each max 100 chars.",
      ),
    scope: z
      .enum(["agent", "user", "org"])
      .default("agent")
      .describe(
        "Visibility: 'agent' (only this agent sees it, default), 'user' (all agents for this user, requires user_id), 'org' (all agents in the organization, requires org membership).",
      ),
  },
  async ({ content, agent_id, user_id, tags, scope }) => {
    const result = await apiCall("/memories/remember", "POST", {
      agent_id,
      user_id,
      content,
      tags,
      scope,
    });

    const memory = (result as { memory: { id: string; created_at: string } })
      .memory;
    return {
      content: [
        {
          type: "text" as const,
          text: `Remembered (id: ${memory.id}, stored at: ${memory.created_at}). This memory will be available in future sessions.`,
        },
      ],
    };
  },
);

// Tool 2: recall
server.tool(
  "recall",
  `Search persistent memory by meaning, returning the most relevant past memories ranked by semantic similarity. This is a read-only operation that runs a 4-way hybrid search (vector similarity, BM25 full-text, entity graph traversal, temporal proximity) and reranks results with a cross-encoder model. Use recall (not context) when you need to answer a specific question: "what language does the user prefer?", "how was auth implemented?", "what was decided about the database?". Do not use for broad session bootstrapping (use context instead). Returns up to limit memories with relevance scores (0-1). Costs 1 operation per call. If no memories match, returns an empty list, not an error.`,
  {
    query: z
      .string()
      .describe(
        "Natural language search query. Semantic, not keyword-based: 'what programming language does the user prefer?' works better than 'language preference'. More specific queries return more relevant results.",
      ),
    agent_id: z
      .string()
      .default("default")
      .describe("Agent instance identifier. Must match the agent_id used when storing memories. Default: 'default'."),
    user_id: z
      .string()
      .optional()
      .describe("User identifier. When provided with scope 'user', also searches user-scoped memories shared by other agents."),
    scope: z
      .enum(["agent", "user", "org"])
      .optional()
      .describe(
        "Search scope. 'agent' (default): only this agent's memories. 'user': also includes memories shared to user scope. 'org': includes org-wide memories. Broader scope returns more results but may include less relevant memories.",
      ),
    tags: z
      .array(z.string())
      .optional()
      .describe("Filter results to only memories with at least one matching tag. Omit to search all memories regardless of tags."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(20)
      .default(5)
      .describe("Maximum memories to return, 1-20. Default 5. Use higher values (10-20) for broad searches, lower (1-3) for targeted lookups."),
  },
  async ({ query, agent_id, user_id, scope, tags, limit }) => {
    const result = await apiCall("/memories/recall", "POST", {
      agent_id,
      user_id,
      query,
      scope,
      tags,
      limit,
    });

    const memories = (
      result as {
        memories: Array<{
          id: string;
          content: string;
          relevance_score: number;
          tags: string[];
          scope: string;
          created_at: string;
        }>;
      }
    ).memories;

    if (memories.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: "No relevant memories found.",
          },
        ],
      };
    }

    const formatted = memories
      .map(
        (m, i) =>
          `[${i + 1}] (score: ${(m.relevance_score * 100).toFixed(1)}%, scope: ${m.scope}, id: ${m.id})\n${m.content}${m.tags.length > 0 ? `\ntags: ${m.tags.join(", ")}` : ""}`,
      )
      .join("\n\n");

    return {
      content: [
        {
          type: "text" as const,
          text: `Found ${memories.length} relevant memories:\n\n${formatted}`,
        },
      ],
    };
  },
);

// Tool 3: forget
server.tool(
  "forget",
  `Permanently delete a memory by ID. This is a destructive, irreversible operation that soft-deletes the memory record (it will no longer appear in recall or context results). Use forget before storing a corrected version of a fact, to prevent contradictory memories from coexisting. Do not use for bulk cleanup (delete one at a time). Do not use if you are unsure whether the memory is outdated, as deletion cannot be undone. Requires the exact memory ID (UUID), which is returned by recall and context. Costs 1 operation. Returns confirmation on success, or an error if the ID does not exist.`,
  {
    memory_id: z.string().describe("UUID of the memory to delete. Get this from recall or context results (the 'id' field). Must be an exact match."),
  },
  async ({ memory_id }) => {
    await apiCall(`/memories/${memory_id}`, "DELETE");
    return {
      content: [
        {
          type: "text" as const,
          text: `Memory ${memory_id} has been deleted.`,
        },
      ],
    };
  },
);

// Tool 4: context
server.tool(
  "context",
  `Load relevant memories for the current task, designed for session bootstrapping. This is a read-only operation identical to recall internally, but optimized for broad context loading rather than specific questions. Call context at the start of every conversation, passing a description of what you are working on, to retrieve past decisions, preferences, and project knowledge. Also call when switching topics mid-session. Use context (not recall) for "what do I need to know about X?" and recall for "what specifically was decided about Y?". Returns up to max_memories results ranked by relevance. Costs 1 operation. Returns empty list (not error) if no relevant memories exist.`,
  {
    current_context: z
      .string()
      .describe(
        "Description of what you are currently working on. Be specific: 'refactoring the authentication middleware in the Express API' retrieves better context than 'working on auth'. This is the search query for memory retrieval.",
      ),
    agent_id: z
      .string()
      .default("default")
      .describe("Agent instance identifier. Must match the agent_id used when storing memories. Default: 'default'."),
    user_id: z
      .string()
      .optional()
      .describe("User identifier. When provided, also retrieves user-scoped memories shared by other agents."),
    max_memories: z
      .number()
      .int()
      .min(1)
      .max(20)
      .default(5)
      .describe("Maximum memories to return, 1-20. Default 5. Use 10-15 at session start for broad context loading, 3-5 for topic switches."),
  },
  async ({ current_context, agent_id, user_id, max_memories }) => {
    const result = await apiCall("/memories/context", "POST", {
      agent_id,
      user_id,
      current_context,
      max_memories,
    });

    const memories = (
      result as {
        memories: Array<{
          id: string;
          content: string;
          relevance_score: number;
          scope: string;
        }>;
      }
    ).memories;

    if (memories.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: "No relevant past context found. This appears to be a new topic.",
          },
        ],
      };
    }

    const formatted = memories
      .map(
        (m, i) =>
          `[${i + 1}] (relevance: ${(m.relevance_score * 100).toFixed(1)}%)\n${m.content}`,
      )
      .join("\n\n");

    return {
      content: [
        {
          type: "text" as const,
          text: `Loaded ${memories.length} relevant memories from past sessions:\n\n${formatted}`,
        },
      ],
    };
  },
);

// Tool 5: share
server.tool(
  "share",
  `Widen a memory's visibility scope so other agents can access it. This is a write operation that changes the memory's scope from agent-only to user-level or org-level. Use share when a memory contains knowledge valuable beyond the current agent: user preferences (share to user scope so all agents know), team conventions (share to org scope). Do not use to restrict scope (sharing is one-directional: agent to user to org). Requires the memory ID (from recall or remember) and the target scope. Does not duplicate the memory, only changes its visibility. Costs 1 operation.`,
  {
    memory_id: z.string().describe("UUID of the memory to share. Get this from recall, context, or remember results."),
    target_scope: z
      .enum(["user", "org"])
      .describe(
        "New visibility level. 'user': all agents serving this user can recall it. 'org': all agents in the organization can recall it. Cannot go back to 'agent' once shared.",
      ),
    user_id: z
      .string()
      .optional()
      .describe("Required when target_scope is 'user'. Identifies which user's agents should see this memory."),
  },
  async ({ memory_id, target_scope, user_id }) => {
    await apiCall(`/memories/${memory_id}/share`, "POST", {
      target_scope,
      user_id,
    });
    return {
      content: [
        {
          type: "text" as const,
          text: `Memory ${memory_id} is now shared at ${target_scope} scope. Other agents with ${target_scope} access can now recall this memory.`,
        },
      ],
    };
  },
);

// --- Start ---

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Failed to start Central Intelligence MCP server:", err);
  process.exit(1);
});
