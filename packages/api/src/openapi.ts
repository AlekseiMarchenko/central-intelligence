/**
 * OpenAPI 3.1 spec — auto-generated from the Zod schemas that validate actual
 * request bodies. Source of truth is `packages/api/src/routes/*.ts`. Adding a
 * field to a Zod schema in a route file immediately flows into this spec.
 *
 * Consumed by:
 *   - GET /docs/openapi.json              (this API)
 *   - GET /docs/json                      (legacy proprietary shape, re-derived)
 *   - https://centralintelligence.online/vt220/docs   (VT220 docs page)
 */

import { OpenAPIRegistry, OpenApiGeneratorV31, extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";

// Patch Zod with .openapi() — must run before any .openapi() call
extendZodWithOpenApi(z);

// Import the validated schemas from route files (single source of truth)
import {
  rememberSchema,
  recallSchema,
  contextSchema,
  shareSchema,
  buildGraphSchema,
} from "./routes/memories.js";
import { createKeySchema } from "./routes/keys.js";

const registry = new OpenAPIRegistry();

// --- Reusable components ---

const BearerAuth = registry.registerComponent("securitySchemes", "BearerAuth", {
  type: "http",
  scheme: "bearer",
  bearerFormat: "API Key",
  description: "API key prefixed with `ci_sk_`. Create one via `POST /keys` (no auth required).",
});

const ErrorResponse = registry.register(
  "ErrorResponse",
  z.object({
    error: z.string(),
    details: z.any().optional(),
  })
);

const MemoryObject = registry.register(
  "Memory",
  z.object({
    id: z.string().uuid(),
    agent_id: z.string(),
    user_id: z.string().nullable().optional(),
    org_id: z.string().nullable().optional(),
    scope: z.enum(["agent", "user", "org"]),
    content: z.string(),
    tags: z.array(z.string()),
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
  })
);

const MemoryWithScore = registry.register(
  "MemoryWithScore",
  z.object({
    id: z.string().uuid(),
    agent_id: z.string(),
    user_id: z.string().nullable().optional(),
    org_id: z.string().nullable().optional(),
    scope: z.enum(["agent", "user", "org"]),
    content: z.string(),
    tags: z.array(z.string()),
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
    relevance_score: z.number().describe("Rerank score, 0–1 (higher = more relevant)"),
  })
);

// --- Register request schemas (gives them named $refs in the spec) ---

registry.register("RememberRequest", rememberSchema);
registry.register("RecallRequest", recallSchema);
registry.register("ContextRequest", contextSchema);
registry.register("ShareRequest", shareSchema);
registry.register("BuildGraphRequest", buildGraphSchema);
registry.register("CreateKeyRequest", createKeySchema);

// --- Path registrations ---

const jsonBody = (schema: z.ZodType) => ({
  body: { content: { "application/json": { schema } }, required: true },
});

registry.registerPath({
  method: "post",
  path: "/keys",
  summary: "Create a new API key",
  description:
    "Create a new API key. No authentication required. Save the returned `key` — it won't be shown again.",
  tags: ["Auth"],
  security: [],
  request: jsonBody(createKeySchema),
  responses: {
    201: {
      description: "Key created",
      content: {
        "application/json": {
          schema: z.object({
            id: z.string().uuid(),
            key: z.string().describe("Raw API key prefixed with `ci_sk_` — shown once, save it"),
            message: z.string(),
          }),
        },
      },
    },
    400: { description: "Invalid request", content: { "application/json": { schema: ErrorResponse } } },
  },
});

registry.registerPath({
  method: "delete",
  path: "/keys/revoke",
  summary: "Revoke the current API key",
  description: "Invalidates the API key used to authenticate this request.",
  tags: ["Auth"],
  security: [{ BearerAuth: [] }],
  responses: {
    200: {
      description: "Key revoked",
      content: { "application/json": { schema: z.object({ revoked: z.boolean() }) } },
    },
    401: { description: "Missing or invalid API key", content: { "application/json": { schema: ErrorResponse } } },
  },
});

registry.registerPath({
  method: "post",
  path: "/memories/remember",
  summary: "Store a memory",
  description:
    "Store a memory. Content is embedded (text-embedding-3-small) and indexed (pgvector HNSW + BM25 tsvector) for hybrid retrieval. `event_date_from`/`event_date_to` optionally describe when the event happened (distinct from `created_at`).",
  tags: ["Memories"],
  security: [{ BearerAuth: [] }],
  request: jsonBody(rememberSchema),
  responses: {
    201: {
      description: "Memory stored",
      content: { "application/json": { schema: z.object({ memory: MemoryObject }) } },
    },
    400: { description: "Invalid request", content: { "application/json": { schema: ErrorResponse } } },
    401: { description: "Missing or invalid API key", content: { "application/json": { schema: ErrorResponse } } },
    403: { description: "Memory limit reached for tier", content: { "application/json": { schema: ErrorResponse } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: ErrorResponse } } },
  },
});

registry.registerPath({
  method: "post",
  path: "/memories/recall",
  summary: "Search memories",
  description:
    "Hybrid retrieval: pgvector HNSW + BM25 → RRF fusion → temporal decay → bge-reranker-v2-m3 cross-encoder. Returns top matches ordered by `relevance_score` (higher = more relevant). `date_from`/`date_to` optionally restrict to memories whose event window overlaps the requested range.",
  tags: ["Memories"],
  security: [{ BearerAuth: [] }],
  request: jsonBody(recallSchema),
  responses: {
    200: {
      description: "Matching memories",
      content: { "application/json": { schema: z.object({ memories: z.array(MemoryWithScore) }) } },
    },
    400: { description: "Invalid request", content: { "application/json": { schema: ErrorResponse } } },
    401: { description: "Missing or invalid API key", content: { "application/json": { schema: ErrorResponse } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: ErrorResponse } } },
  },
});

registry.registerPath({
  method: "post",
  path: "/memories/context",
  summary: "Auto-load context for a task",
  description:
    "Describe what you're working on; the API recalls the most relevant memories across all visible scopes. Convenience wrapper around `/memories/recall` that picks the widest relevant scope automatically.",
  tags: ["Memories"],
  security: [{ BearerAuth: [] }],
  request: jsonBody(contextSchema),
  responses: {
    200: {
      description: "Context memories",
      content: { "application/json": { schema: z.object({ memories: z.array(MemoryWithScore) }) } },
    },
    400: { description: "Invalid request", content: { "application/json": { schema: ErrorResponse } } },
    401: { description: "Missing or invalid API key", content: { "application/json": { schema: ErrorResponse } } },
  },
});

registry.registerPath({
  method: "delete",
  path: "/memories/{id}",
  summary: "Delete a memory",
  description: "Soft-delete a memory by ID. Sets `deleted_at`; data retained for audit per retention policy.",
  tags: ["Memories"],
  security: [{ BearerAuth: [] }],
  request: {
    params: z.object({ id: z.string().uuid().describe("Memory ID") }),
  },
  responses: {
    200: {
      description: "Memory deleted",
      content: { "application/json": { schema: z.object({ deleted: z.boolean() }) } },
    },
    401: { description: "Missing or invalid API key", content: { "application/json": { schema: ErrorResponse } } },
    404: { description: "Memory not found", content: { "application/json": { schema: ErrorResponse } } },
  },
});

registry.registerPath({
  method: "post",
  path: "/memories/{id}/share",
  summary: "Share a memory",
  description: "Widen a memory's visibility scope (agent → user → org) so other agents or users can recall it.",
  tags: ["Memories"],
  security: [{ BearerAuth: [] }],
  request: {
    params: z.object({ id: z.string().uuid().describe("Memory ID") }),
    ...jsonBody(shareSchema),
  },
  responses: {
    200: {
      description: "Memory shared",
      content: { "application/json": { schema: z.object({ shared: z.boolean() }) } },
    },
    400: { description: "Invalid target scope or missing org", content: { "application/json": { schema: ErrorResponse } } },
    401: { description: "Missing or invalid API key", content: { "application/json": { schema: ErrorResponse } } },
    404: { description: "Memory not found", content: { "application/json": { schema: ErrorResponse } } },
  },
});

registry.registerPath({
  method: "post",
  path: "/memories/extract",
  summary: "Extract structured facts (Enterprise preview)",
  description:
    "Processes all pending memories through GPT-4o-mini fact extraction: atomic facts, entities, temporal info, causal relations. Writes to `fact_units` table. Dormant by default — call explicitly to enrich memories for graph retrieval. Enterprise tier will run this automatically.",
  tags: ["Memories", "Enterprise"],
  security: [{ BearerAuth: [] }],
  responses: {
    200: {
      description: "Extraction results",
      content: {
        "application/json": {
          schema: z.object({
            processed: z.number(),
            failed: z.number(),
            remaining: z.number(),
          }),
        },
      },
    },
    401: { description: "Missing or invalid API key", content: { "application/json": { schema: ErrorResponse } } },
    500: { description: "Extraction pipeline failure", content: { "application/json": { schema: ErrorResponse } } },
  },
});

registry.registerPath({
  method: "post",
  path: "/memories/build-graph",
  summary: "Build entity graph (Enterprise preview)",
  description:
    "After extraction, resolve entities and build the entity→fact graph + temporal/causal fact_links for multi-hop retrieval. Dormant by default. Enterprise tier.",
  tags: ["Memories", "Enterprise"],
  security: [{ BearerAuth: [] }],
  request: jsonBody(buildGraphSchema),
  responses: {
    200: {
      description: "Graph built",
      content: {
        "application/json": {
          schema: z.object({
            entities: z.number(),
            links: z.number(),
            temporal: z.number(),
          }),
        },
      },
    },
    400: { description: "agent_id required", content: { "application/json": { schema: ErrorResponse } } },
    401: { description: "Missing or invalid API key", content: { "application/json": { schema: ErrorResponse } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/usage",
  summary: "Get usage stats",
  description: "Memory counts, 30-day usage events, and active agents for the authenticated API key.",
  tags: ["Account"],
  security: [{ BearerAuth: [] }],
  responses: {
    200: {
      description: "Usage summary",
      content: {
        "application/json": {
          schema: z.object({
            memories: z.object({
              total: z.number(),
              by_scope: z.object({
                agent: z.number(),
                user: z.number(),
                org: z.number(),
              }),
            }),
            events_30d: z.record(
              z.string(),
              z.object({ count: z.number(), tokens: z.number() })
            ),
            active_agents: z.array(z.string()),
          }),
        },
      },
    },
    401: { description: "Missing or invalid API key", content: { "application/json": { schema: ErrorResponse } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/payments/info",
  summary: "Payment configuration",
  description: "Returns payment endpoint metadata for x402-compatible clients (accepted currencies, minimum amounts, etc.).",
  tags: ["Payments"],
  security: [],
  responses: {
    200: {
      description: "Payment info",
      content: { "application/json": { schema: z.any() } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/payments/balance",
  summary: "Get credit balance",
  description: "Prepaid credit balance for the authenticated API key.",
  tags: ["Payments"],
  security: [{ BearerAuth: [] }],
  responses: {
    200: {
      description: "Current balance",
      content: {
        "application/json": {
          schema: z.object({
            balance: z.number().describe("USDC credit remaining"),
            currency: z.string(),
          }),
        },
      },
    },
    401: { description: "Missing or invalid API key", content: { "application/json": { schema: ErrorResponse } } },
  },
});

registry.registerPath({
  method: "post",
  path: "/payments/verify",
  summary: "Submit payment proof",
  description: "Verify an x402 on-chain payment and credit the authenticated API key.",
  tags: ["Payments"],
  security: [{ BearerAuth: [] }],
  responses: {
    200: {
      description: "Payment verified and credited",
      content: { "application/json": { schema: z.any() } },
    },
    400: { description: "Invalid payment proof", content: { "application/json": { schema: ErrorResponse } } },
    401: { description: "Missing or invalid API key", content: { "application/json": { schema: ErrorResponse } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/payments/history",
  summary: "Payment history",
  description: "List prior payments and credits for the authenticated API key.",
  tags: ["Payments"],
  security: [{ BearerAuth: [] }],
  responses: {
    200: {
      description: "Payment history",
      content: { "application/json": { schema: z.any() } },
    },
    401: { description: "Missing or invalid API key", content: { "application/json": { schema: ErrorResponse } } },
  },
});

// --- Generator ---

const API_VERSION = "1.2.2";
const BASE_URL = "https://central-intelligence-api.fly.dev";

export function buildOpenApiSpec() {
  const generator = new OpenApiGeneratorV31(registry.definitions);
  return generator.generateDocument({
    openapi: "3.1.0",
    info: {
      title: "Central Intelligence API",
      version: API_VERSION,
      description:
        "Persistent memory for AI agents. Hybrid retrieval (pgvector HNSW + BM25 + cross-encoder rerank). " +
        "75.0% LongMemEval, 52.2% LifeBench. Open source, self-hostable.\n\n" +
        "See https://github.com/AlekseiMarchenko/central-intelligence and https://centralintelligence.online.",
      contact: { url: "https://centralintelligence.online" },
      license: { name: "Apache-2.0", url: "https://www.apache.org/licenses/LICENSE-2.0" },
      "x-logo": { url: "https://centralintelligence.online/logo.png" },
    },
    servers: [{ url: BASE_URL, description: "Production" }],
    tags: [
      { name: "Memories", description: "Store, recall, share, and manage memories" },
      { name: "Auth", description: "API key lifecycle" },
      { name: "Account", description: "Usage and billing" },
      { name: "Payments", description: "x402-compatible credit top-ups" },
      { name: "Enterprise", description: "Preview features for the Enterprise tier (graph retrieval, fact extraction)" },
    ],
  });
}

// Derived legacy proprietary shape (for backward-compatible /docs/json consumers).
export function buildLegacyApiSpec() {
  const spec = buildOpenApiSpec();
  const endpoints: any[] = [];
  for (const [path, pathItem] of Object.entries(spec.paths || {})) {
    for (const [method, op] of Object.entries(pathItem as any)) {
      if (!["get", "post", "put", "patch", "delete"].includes(method)) continue;
      const operation = op as any;
      endpoints.push({
        method: method.toUpperCase(),
        path: path.replace(/\{(\w+)\}/g, ":$1"),
        auth: (operation.security?.length ?? 1) > 0,
        description: operation.description || operation.summary,
        summary: operation.summary,
        tags: operation.tags || [],
      });
    }
  }
  return {
    name: "Central Intelligence API",
    version: API_VERSION,
    description: spec.info.description,
    base_url: BASE_URL,
    auth: {
      type: "bearer",
      header: "Authorization",
      format: "Bearer <api-key>",
      note: "Get a key via POST /keys (no auth required)",
    },
    endpoints,
    rate_limits: {
      free: { requests_per_minute: 120, max_memories: 500 },
      pro: { requests_per_minute: 120, max_memories: 50_000 },
      team: { requests_per_minute: 600, max_memories: 500_000 },
      enterprise: { requests_per_minute: 3000, max_memories: "unlimited" },
    },
    errors: {
      400: "Invalid request body",
      401: "Missing or invalid API key",
      403: "Memory limit reached for your tier",
      404: "Resource not found",
      429: "Rate limit exceeded",
      500: "Internal server error",
    },
  };
}
