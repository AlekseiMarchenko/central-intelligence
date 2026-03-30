#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { store, softDelete, updateScope } from "./db.js";
import { embed } from "./embeddings.js";
import { hybridSearch } from "./search.js";

const server = new McpServer({
  name: "Central Intelligence Local",
  version: "1.0.0",
});

// --- remember ---
server.tool(
  "remember",
  "Store information for later recall. Use this to save decisions, preferences, architecture details, or anything worth remembering across sessions.",
  {
    agent_id: z.string().describe("Unique identifier for the calling agent"),
    user_id: z.string().optional().describe("User ID for user-scoped memories"),
    content: z.string().max(10000).describe("The information to remember"),
    tags: z.array(z.string()).optional().describe("Tags for categorization"),
    scope: z.enum(["agent", "user", "org"]).optional().describe("Visibility scope"),
  },
  async ({ agent_id, user_id, content, tags, scope }) => {
    try {
      const embedding = await embed(content);
      const memory = store(agent_id, content, embedding, { userId: user_id, scope, tags });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              stored: true,
              memory: {
                id: memory.id,
                content: memory.content,
                scope: memory.scope,
                created_at: memory.created_at,
              },
            }),
          },
        ],
      };
    } catch (err: any) {
      return {
        content: [{ type: "text" as const, text: `Error storing memory: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// --- recall ---
server.tool(
  "recall",
  "Search your memories by meaning, not just keywords. Use this to find past decisions, preferences, or context from previous sessions.",
  {
    agent_id: z.string().describe("Unique identifier for the calling agent"),
    user_id: z.string().optional().describe("User ID for user-scoped recall"),
    query: z.string().describe("What to search for (natural language)"),
    scope: z.enum(["agent", "user", "org"]).optional().describe("Search scope"),
    tags: z.array(z.string()).optional().describe("Filter by tags"),
    limit: z.number().optional().describe("Max results (default 10)"),
  },
  async ({ agent_id, query, scope, tags, limit }) => {
    try {
      const memories = await hybridSearch(agent_id, query, { scope, tags, limit });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              memories: memories.map((m) => ({
                id: m.id,
                content: m.content,
                relevance_score: m.relevance_score,
                tags: m.tags,
                scope: m.scope,
                created_at: m.created_at,
              })),
              count: memories.length,
              mode: "local",
            }),
          },
        ],
      };
    } catch (err: any) {
      return {
        content: [{ type: "text" as const, text: `Error recalling: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// --- context ---
server.tool(
  "context",
  "Auto-load relevant context for your current task. Call this at the start of a session to get up to speed.",
  {
    agent_id: z.string().describe("Unique identifier for the calling agent"),
    user_id: z.string().optional().describe("User ID for scoped context"),
    current_context: z.string().describe("Brief description of what you're working on"),
    max_memories: z.number().optional().describe("Max memories to load (default 5)"),
  },
  async ({ agent_id, current_context, max_memories }) => {
    try {
      const memories = await hybridSearch(agent_id, current_context, {
        limit: max_memories || 5,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              context: memories.map((m) => ({
                id: m.id,
                content: m.content,
                relevance_score: m.relevance_score,
                scope: m.scope,
              })),
              count: memories.length,
              mode: "local",
            }),
          },
        ],
      };
    } catch (err: any) {
      return {
        content: [{ type: "text" as const, text: `Error loading context: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// --- forget ---
server.tool(
  "forget",
  "Delete a memory that is outdated or incorrect.",
  {
    memory_id: z.string().describe("ID of the memory to delete"),
  },
  async ({ memory_id }) => {
    try {
      const deleted = softDelete(memory_id);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ deleted, memory_id }),
          },
        ],
      };
    } catch (err: any) {
      return {
        content: [{ type: "text" as const, text: `Error forgetting: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// --- share ---
server.tool(
  "share",
  "Change a memory's visibility scope. Promote from agent-only to user or org level so other agents can access it.",
  {
    memory_id: z.string().describe("ID of the memory to share"),
    target_scope: z.enum(["user", "org"]).describe("New scope"),
    user_id: z.string().optional().describe("User ID (for user scope)"),
  },
  async ({ memory_id, target_scope, user_id }) => {
    try {
      const shared = updateScope(memory_id, target_scope, user_id);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ shared, memory_id, scope: target_scope }),
          },
        ],
      };
    } catch (err: any) {
      return {
        content: [{ type: "text" as const, text: `Error sharing: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// --- Update check (non-blocking, silent on failure) ---
const CURRENT_VERSION = "1.0.0";

async function checkForUpdates() {
  try {
    const res = await fetch(
      `https://central-intelligence-api.fly.dev/versions/local?current=${CURRENT_VERSION}`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (res.ok) {
      const data = await res.json() as { latest: string; message?: string };
      if (data.latest !== CURRENT_VERSION) {
        console.error(`[CI Local] Update available: v${CURRENT_VERSION} → v${data.latest}`);
        if (data.message) console.error(`[CI Local] ${data.message}`);
      }
    }
  } catch {
    // Silent — never block startup for an update check
  }
}

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Central Intelligence Local — MCP server running (local SQLite + local embeddings)");
  console.error("Database: ~/.central-intelligence/memories.db");

  // Non-blocking update check
  checkForUpdates();
}

main().catch((err) => {
  console.error("Failed to start:", err);
  process.exit(1);
});
