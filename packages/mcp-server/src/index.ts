#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const API_BASE = process.env.CI_API_URL || "https://api.centralintelligence.ai";
const API_KEY = process.env.CI_API_KEY || "";

if (!API_KEY) {
  console.error(
    "CI_API_KEY not set. Get one at https://centralintelligence.ai or run: npx central-intelligence-cli signup",
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
  version: "0.1.0",
});

// Tool 1: remember
server.tool(
  "remember",
  "Store information in persistent memory for later recall. Use when you learn something that should be remembered across sessions — user preferences, project decisions, important facts, or anything you might need later.",
  {
    content: z
      .string()
      .describe(
        "The information to remember. Be specific and include context so it's useful when recalled later.",
      ),
    agent_id: z
      .string()
      .default("default")
      .describe("Identifier for this agent instance"),
    user_id: z
      .string()
      .optional()
      .describe("User identifier for user-scoped memories"),
    tags: z
      .array(z.string())
      .default([])
      .describe(
        "Tags for categorizing the memory (e.g., 'preference', 'decision', 'fact')",
      ),
    scope: z
      .enum(["agent", "user", "org"])
      .default("agent")
      .describe(
        "Visibility scope: agent (only this agent), user (all agents for this user), org (all agents in the organization)",
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
  "Search persistent memory for relevant past information. Use when you need to check if you've encountered something before, recall past context, retrieve user preferences, or access what was learned in previous sessions.",
  {
    query: z
      .string()
      .describe(
        "What to search for. Use natural language — the search is semantic, not keyword-based.",
      ),
    agent_id: z
      .string()
      .default("default")
      .describe("Identifier for this agent instance"),
    user_id: z
      .string()
      .optional()
      .describe("User identifier to include user-scoped memories"),
    scope: z
      .enum(["agent", "user", "org"])
      .optional()
      .describe(
        "Search scope: agent (only this agent's memories), user (include user-scoped), org (include org-scoped)",
      ),
    tags: z
      .array(z.string())
      .optional()
      .describe("Filter by tags"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(20)
      .default(5)
      .describe("Maximum number of memories to return"),
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
  "Delete a specific memory by ID. Use when a stored memory is no longer accurate or relevant.",
  {
    memory_id: z.string().describe("The ID of the memory to delete"),
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
  "Automatically retrieve relevant memories based on what you're currently working on. Use at the start of a session or when switching tasks to load relevant past context.",
  {
    current_context: z
      .string()
      .describe(
        "A summary of what you're currently working on or discussing. The more specific, the better the recalled memories will be.",
      ),
    agent_id: z
      .string()
      .default("default")
      .describe("Identifier for this agent instance"),
    user_id: z
      .string()
      .optional()
      .describe("User identifier to include user-scoped memories"),
    max_memories: z
      .number()
      .int()
      .min(1)
      .max(20)
      .default(5)
      .describe("Maximum number of memories to return"),
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
  "Share a memory with a broader scope so other agents can access it. Use when you learn something that would be valuable to other agents serving the same user or organization.",
  {
    memory_id: z.string().describe("The ID of the memory to share"),
    target_scope: z
      .enum(["user", "org"])
      .describe(
        "Who to share with: user (all agents for this user) or org (all agents in the organization)",
      ),
    user_id: z
      .string()
      .optional()
      .describe("Required when sharing to user scope"),
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
