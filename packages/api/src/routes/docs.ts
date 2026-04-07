import { Hono } from "hono";

const app = new Hono();

const API_SPEC = {
  name: "Central Intelligence API",
  version: "0.1.0",
  description:
    "Persistent memory for AI agents. Store, recall, and share knowledge across sessions.",
  base_url: "https://central-intelligence-api.fly.dev",
  auth: {
    type: "bearer",
    header: "Authorization",
    format: "Bearer <api-key>",
    note: "Get a key via POST /keys (no auth required)",
  },
  endpoints: [
    {
      method: "POST",
      path: "/keys",
      auth: false,
      description: "Create a new API key. No authentication required.",
      request: {
        body: {
          name: { type: "string", default: "default", description: "Key name" },
          org_id: { type: "string", optional: true, description: "Organization ID for org-scoped memories" },
        },
      },
      response: {
        status: 201,
        body: {
          id: "uuid",
          key: "ci_sk_...",
          message: "Save this key — it won't be shown again.",
        },
      },
      example: {
        curl: `curl -X POST https://central-intelligence-api.fly.dev/keys -H "Content-Type: application/json" -d '{"name": "my-agent"}'`,
      },
    },
    {
      method: "POST",
      path: "/memories/remember",
      auth: true,
      description:
        "Store a memory. The content is embedded for semantic search and persisted across sessions.",
      request: {
        body: {
          agent_id: { type: "string", required: true, description: "Identifier for the agent storing this memory" },
          content: { type: "string", required: true, max_length: 10000, description: "The information to remember" },
          user_id: { type: "string", optional: true, description: "User identifier for user-scoped memories" },
          scope: { type: "enum", values: ["agent", "user", "org"], default: "agent", description: "Visibility scope" },
          tags: { type: "string[]", default: [], description: "Tags for categorization" },
        },
      },
      response: {
        status: 201,
        body: {
          memory: {
            id: "uuid",
            agent_id: "string",
            content: "string",
            scope: "agent",
            tags: ["string"],
            created_at: "ISO8601",
          },
        },
      },
      example: {
        curl: `curl -X POST https://central-intelligence-api.fly.dev/memories/remember -H "Authorization: Bearer ci_sk_..." -H "Content-Type: application/json" -d '{"agent_id": "my-agent", "content": "User prefers TypeScript", "tags": ["preference"]}'`,
      },
    },
    {
      method: "POST",
      path: "/memories/recall",
      auth: true,
      description:
        "Search memories using semantic similarity. Returns the most relevant memories ranked by cosine similarity to the query.",
      request: {
        body: {
          agent_id: { type: "string", required: true, description: "Agent identifier" },
          query: { type: "string", required: true, description: "Natural language search query" },
          user_id: { type: "string", optional: true, description: "Include user-scoped memories" },
          scope: { type: "enum", values: ["agent", "user", "org"], optional: true, description: "Search scope" },
          tags: { type: "string[]", optional: true, description: "Filter by tags" },
          limit: { type: "integer", default: 10, min: 1, max: 50, description: "Maximum results" },
        },
      },
      response: {
        status: 200,
        body: {
          memories: [
            {
              id: "uuid",
              content: "string",
              relevance_score: 0.434,
              scope: "agent",
              tags: ["string"],
              created_at: "ISO8601",
            },
          ],
        },
      },
      example: {
        curl: `curl -X POST https://central-intelligence-api.fly.dev/memories/recall -H "Authorization: Bearer ci_sk_..." -H "Content-Type: application/json" -d '{"agent_id": "my-agent", "query": "what language does the user prefer?"}'`,
      },
    },
    {
      method: "POST",
      path: "/memories/context",
      auth: true,
      description:
        "Auto-load relevant memories for the current task. Describe what you're working on and get back everything relevant from past sessions.",
      request: {
        body: {
          agent_id: { type: "string", required: true, description: "Agent identifier" },
          current_context: { type: "string", required: true, description: "Description of current task" },
          user_id: { type: "string", optional: true, description: "Include user-scoped memories" },
          max_memories: { type: "integer", default: 5, min: 1, max: 20, description: "Maximum memories to return" },
        },
      },
      response: {
        status: 200,
        body: {
          memories: [{ id: "uuid", content: "string", relevance_score: 0.5, scope: "agent" }],
        },
      },
      example: {
        curl: `curl -X POST https://central-intelligence-api.fly.dev/memories/context -H "Authorization: Bearer ci_sk_..." -H "Content-Type: application/json" -d '{"agent_id": "my-agent", "current_context": "Setting up auth for the project"}'`,
      },
    },
    {
      method: "DELETE",
      path: "/memories/:id",
      auth: true,
      description: "Soft-delete a memory by ID.",
      request: { params: { id: { type: "uuid", description: "Memory ID" } } },
      response: { status: 200, body: { deleted: true } },
      example: {
        curl: `curl -X DELETE https://central-intelligence-api.fly.dev/memories/MEMORY_ID -H "Authorization: Bearer ci_sk_..."`,
      },
    },
    {
      method: "POST",
      path: "/memories/:id/share",
      auth: true,
      description:
        "Share a memory with a broader scope so other agents can access it.",
      request: {
        params: { id: { type: "uuid", description: "Memory ID" } },
        body: {
          target_scope: { type: "enum", values: ["user", "org"], required: true, description: "Target scope" },
          user_id: { type: "string", optional: true, description: "Required when sharing to user scope" },
        },
      },
      response: { status: 200, body: { shared: true } },
      example: {
        curl: `curl -X POST https://central-intelligence-api.fly.dev/memories/MEMORY_ID/share -H "Authorization: Bearer ci_sk_..." -H "Content-Type: application/json" -d '{"target_scope": "org"}'`,
      },
    },
    {
      method: "GET",
      path: "/usage",
      auth: true,
      description: "Get memory counts, usage events, and active agents for the authenticated API key.",
      request: {},
      response: {
        status: 200,
        body: {
          memories: { total: 42, by_scope: { agent: 30, user: 10, org: 2 } },
          events_30d: { remember: { count: 100, tokens: 5000 }, recall: { count: 200, tokens: 3000 } },
          active_agents: ["agent-1", "agent-2"],
        },
      },
      example: {
        curl: `curl https://central-intelligence-api.fly.dev/usage -H "Authorization: Bearer ci_sk_..."`,
      },
    },
  ],
  rate_limits: {
    free: { requests_per_minute: 30, max_memories: 500 },
    pro: { requests_per_minute: 120, max_memories: 50000 },
    team: { requests_per_minute: 600, max_memories: 500000 },
    enterprise: { requests_per_minute: 3000, max_memories: "unlimited" },
  },
  errors: {
    401: "Missing or invalid API key",
    403: "Memory limit reached for your tier",
    429: "Rate limit exceeded",
    500: "Internal server error",
  },
};

// JSON docs (for agents)
app.get("/json", (c) => c.json(API_SPEC));

// OpenAPI 3.1 spec (for ChatGPT Custom GPTs, Swagger, etc.)
app.get("/openapi.json", (c) => {
  const baseUrl = "https://api.centralintelligence.online";
  return c.json({
    openapi: "3.1.0",
    info: {
      title: "Central Intelligence API",
      description: "Persistent memory for AI agents. Store, recall, and share knowledge across sessions with semantic search.",
      version: "0.2.0",
      contact: { url: "https://centralintelligence.online" },
      "x-logo": { url: "https://centralintelligence.online/logo.png" },
    },
    servers: [{ url: baseUrl, description: "Production" }],
    paths: {
      "/memories/remember": {
        post: {
          operationId: "remember",
          summary: "Store a memory",
          description: "Store information for later recall. Content is embedded for semantic search and persists across sessions.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["agent_id", "content"],
                  properties: {
                    agent_id: { type: "string", description: "Unique agent identifier" },
                    content: { type: "string", maxLength: 10000, description: "The information to remember" },
                    tags: { type: "array", items: { type: "string" }, description: "Tags for categorization" },
                    scope: { type: "string", enum: ["agent", "user", "org"], default: "agent", description: "Visibility scope" },
                    user_id: { type: "string", description: "User ID for user-scoped memories" },
                  },
                },
              },
            },
          },
          responses: {
            "201": {
              description: "Memory stored",
              content: { "application/json": { schema: { type: "object", properties: { memory: { type: "object", properties: { id: { type: "string" }, content: { type: "string" }, scope: { type: "string" }, tags: { type: "array", items: { type: "string" } }, created_at: { type: "string" } } } } } } },
            },
          },
        },
      },
      "/memories/recall": {
        post: {
          operationId: "recall",
          summary: "Search memories",
          description: "Semantic search across stored memories. Finds relevant information by meaning, not just keywords.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["agent_id", "query"],
                  properties: {
                    agent_id: { type: "string", description: "Agent identifier" },
                    query: { type: "string", description: "Natural language search query" },
                    limit: { type: "integer", default: 10, minimum: 1, maximum: 50, description: "Max results" },
                    scope: { type: "string", enum: ["agent", "user", "org"], description: "Search scope" },
                    tags: { type: "array", items: { type: "string" }, description: "Filter by tags" },
                    user_id: { type: "string", description: "Include user-scoped memories" },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Search results",
              content: { "application/json": { schema: { type: "object", properties: { memories: { type: "array", items: { type: "object", properties: { id: { type: "string" }, content: { type: "string" }, similarity: { type: "number" }, scope: { type: "string" }, tags: { type: "array", items: { type: "string" } }, created_at: { type: "string" } } } } } } } },
            },
          },
        },
      },
      "/memories/context": {
        post: {
          operationId: "loadContext",
          summary: "Load relevant context",
          description: "Auto-load relevant memories for the current task. Describe what you're working on, get back everything relevant.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["agent_id", "query"],
                  properties: {
                    agent_id: { type: "string", description: "Agent identifier" },
                    query: { type: "string", description: "Current task description" },
                    user_id: { type: "string", description: "Include user-scoped memories" },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Relevant memories",
              content: { "application/json": { schema: { type: "object", properties: { memories: { type: "array", items: { type: "object", properties: { id: { type: "string" }, content: { type: "string" }, similarity: { type: "number" }, scope: { type: "string" } } } } } } } },
            },
          },
        },
      },
      "/memories/forget": {
        post: {
          operationId: "forget",
          summary: "Delete a memory",
          description: "Delete a memory by ID. Removes outdated or incorrect information.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["agent_id", "memory_id"],
                  properties: {
                    agent_id: { type: "string", description: "Agent identifier" },
                    memory_id: { type: "string", description: "ID of the memory to delete" },
                  },
                },
              },
            },
          },
          responses: {
            "200": { description: "Memory deleted", content: { "application/json": { schema: { type: "object", properties: { deleted: { type: "boolean" } } } } } },
          },
        },
      },
      "/memories/share": {
        post: {
          operationId: "shareMemory",
          summary: "Share a memory",
          description: "Change a memory's visibility scope. Share knowledge between agents, users, or across an organization.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["agent_id", "memory_id", "scope"],
                  properties: {
                    agent_id: { type: "string", description: "Agent identifier" },
                    memory_id: { type: "string", description: "ID of the memory to share" },
                    scope: { type: "string", enum: ["agent", "user", "org"], description: "Target visibility scope" },
                  },
                },
              },
            },
          },
          responses: {
            "200": { description: "Memory shared", content: { "application/json": { schema: { type: "object", properties: { shared: { type: "boolean" } } } } } },
          },
        },
      },
      "/payments/info": {
        get: {
          operationId: "getPaymentInfo",
          summary: "Get pricing and deposit info",
          description: "Public endpoint. Returns pricing, USDC deposit address, and instructions.",
          security: [],
          responses: {
            "200": { description: "Payment info", content: { "application/json": { schema: { type: "object" } } } },
          },
        },
      },
      "/payments/balance": {
        get: {
          operationId: "getBalance",
          summary: "Check account balance",
          description: "Returns current USDC balance, total operations, and estimated remaining operations.",
          responses: {
            "200": { description: "Balance info", content: { "application/json": { schema: { type: "object", properties: { balance_usd: { type: "number" }, estimated_operations_remaining: { type: "integer" }, cost_per_operation: { type: "number" } } } } } },
          },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description: "API key from npx central-intelligence-local signup",
        },
      },
    },
    security: [{ bearerAuth: [] }],
  });
});

// HTML docs (for developers)
app.get("/", (c) => {
  const html = `<!DOCTYPE html>
<html lang="en" style="color-scheme: dark;">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Central Intelligence — API Docs</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg: #09090b; --bg-card: #16161a; --border: #27272a;
      --text: #fafafa; --text-muted: #a1a1aa; --text-dim: #71717a;
      --accent: #6d5aff; --green: #22c55e; --amber: #f59e0b; --red: #ef4444; --cyan: #06b6d4;
      --font: 'Inter', sans-serif; --mono: 'JetBrains Mono', monospace;
    }
    body { font-family: var(--font); background: var(--bg); color: var(--text); line-height: 1.6; }
    .container { max-width: 900px; margin: 0 auto; padding: 60px 24px; }
    h1 { font-size: 32px; font-weight: 700; margin-bottom: 8px; letter-spacing: -1px; }
    h1 span { color: var(--accent); }
    .subtitle { color: var(--text-muted); font-size: 16px; margin-bottom: 40px; }
    .section { margin-bottom: 48px; }
    .section h2 { font-size: 14px; text-transform: uppercase; letter-spacing: 1px; color: var(--text-dim); margin-bottom: 16px; }
    .auth-box { background: var(--bg-card); border: 1px solid var(--border); border-radius: 10px; padding: 20px 24px; margin-bottom: 16px; }
    .auth-box code { font-family: var(--mono); font-size: 13px; color: var(--cyan); }
    .endpoint { background: var(--bg-card); border: 1px solid var(--border); border-radius: 10px; margin-bottom: 12px; overflow: hidden; }
    .endpoint-header { padding: 16px 20px; cursor: pointer; display: flex; align-items: center; gap: 12px; }
    .endpoint-header:hover { background: rgba(255,255,255,0.02); }
    .method { font-family: var(--mono); font-size: 12px; font-weight: 600; padding: 4px 10px; border-radius: 6px; min-width: 60px; text-align: center; }
    .method.post { background: rgba(34,197,94,0.15); color: var(--green); }
    .method.get { background: rgba(6,182,212,0.15); color: var(--cyan); }
    .method.delete { background: rgba(239,68,68,0.15); color: var(--red); }
    .path { font-family: var(--mono); font-size: 14px; font-weight: 500; }
    .desc { color: var(--text-muted); font-size: 13px; margin-left: auto; }
    .lock { color: var(--amber); font-size: 12px; }
    .endpoint-body { display: none; padding: 0 20px 20px; border-top: 1px solid var(--border); }
    .endpoint.open .endpoint-body { display: block; padding-top: 16px; }
    .endpoint.open .chevron { transform: rotate(180deg); }
    .chevron { color: var(--text-dim); transition: transform 0.2s; margin-left: 8px; }
    .param-table { width: 100%; border-collapse: collapse; margin: 12px 0; }
    .param-table th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-dim); padding: 8px 0; border-bottom: 1px solid var(--border); }
    .param-table td { font-size: 13px; padding: 8px 0; border-bottom: 1px solid var(--border); vertical-align: top; }
    .param-table td:first-child { font-family: var(--mono); color: var(--accent); width: 140px; }
    .param-table td:nth-child(2) { font-family: var(--mono); color: var(--text-dim); width: 100px; }
    .param-table td:nth-child(3) { color: var(--text-muted); }
    .required { color: var(--red); font-size: 11px; }
    .curl-box { background: var(--bg); border-radius: 8px; padding: 14px 18px; font-family: var(--mono); font-size: 12px; color: var(--text-muted); overflow-x: auto; white-space: pre-wrap; word-break: break-all; margin-top: 12px; position: relative; }
    .curl-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-dim); margin-top: 16px; margin-bottom: 4px; }
    .response-box { background: var(--bg); border-radius: 8px; padding: 14px 18px; font-family: var(--mono); font-size: 12px; color: var(--green); overflow-x: auto; white-space: pre; margin-top: 8px; }
    .limits { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
    .limit-card { background: var(--bg-card); border: 1px solid var(--border); border-radius: 10px; padding: 16px; text-align: center; }
    .limit-card h3 { font-size: 14px; font-weight: 600; margin-bottom: 8px; }
    .limit-card p { font-size: 12px; color: var(--text-dim); }
    .limit-card .num { font-size: 20px; font-weight: 700; color: var(--accent); }
    .json-link { color: var(--accent); text-decoration: none; font-size: 13px; font-family: var(--mono); }
    .json-link:hover { text-decoration: underline; }
    @media (max-width: 640px) { .limits { grid-template-columns: repeat(2, 1fr); } .desc { display: none; } }
  </style>
</head>
<body>
<div class="container">
  <h1>Central<span>Intelligence</span> API</h1>
  <p class="subtitle">Persistent memory for AI agents. <a href="/docs/json" class="json-link">Machine-readable spec →</a></p>

  <div class="section">
    <h2>Authentication</h2>
    <div class="auth-box">
      <p style="margin-bottom:8px;">All endpoints except <code>POST /keys</code> require a Bearer token:</p>
      <code>Authorization: Bearer ci_sk_your_key_here</code>
      <p style="margin-top:12px;color:var(--text-dim);font-size:13px;">Create a key with <code>POST /keys</code> — no auth needed. Or run: <code>npx central-intelligence-local signup</code></p>
    </div>
  </div>

  <div class="section">
    <h2>Endpoints</h2>
    ${API_SPEC.endpoints
      .map(
        (ep) => `
    <div class="endpoint" onclick="this.classList.toggle('open')">
      <div class="endpoint-header">
        <span class="method ${ep.method.toLowerCase()}">${ep.method}</span>
        <span class="path">${ep.path}</span>
        ${ep.auth ? '<span class="lock">🔒</span>' : ""}
        <span class="desc">${ep.description.split(".")[0]}</span>
        <span class="chevron">▼</span>
      </div>
      <div class="endpoint-body">
        <p style="color:var(--text-muted);font-size:14px;margin-bottom:12px;">${ep.description}</p>
        ${
          ep.request.body
            ? `<table class="param-table">
          <tr><th>Parameter</th><th>Type</th><th>Description</th></tr>
          ${Object.entries(ep.request.body as Record<string, any>)
            .map(
              ([k, v]) =>
                `<tr><td>${k} ${(v as any).required ? '<span class="required">*</span>' : ""}</td><td>${(v as any).type}${(v as any).default !== undefined ? ` = ${(v as any).default}` : ""}</td><td>${(v as any).description || ""}</td></tr>`,
            )
            .join("")}
        </table>`
            : ""
        }
        <div class="curl-label">Example</div>
        <div class="curl-box">${ep.example.curl}</div>
        <div class="curl-label">Response</div>
        <div class="response-box">${JSON.stringify(ep.response.body, null, 2)}</div>
      </div>
    </div>`,
      )
      .join("")}
  </div>

  <div class="section">
    <h2>Rate Limits</h2>
    <div class="limits">
      ${Object.entries(API_SPEC.rate_limits)
        .map(
          ([tier, limits]) => `
      <div class="limit-card">
        <h3>${tier.charAt(0).toUpperCase() + tier.slice(1)}</h3>
        <div class="num">${(limits as any).requests_per_minute}</div>
        <p>req/min</p>
        <p style="margin-top:4px;">${(limits as any).max_memories} memories</p>
      </div>`,
        )
        .join("")}
    </div>
  </div>

  <div class="section">
    <h2>Error Codes</h2>
    <div class="auth-box">
      ${Object.entries(API_SPEC.errors)
        .map(
          ([code, msg]) =>
            `<p style="margin-bottom:4px;"><code style="color:var(--red);">${code}</code> <span style="color:var(--text-muted);font-size:13px;">${msg}</span></p>`,
        )
        .join("")}
    </div>
  </div>
</div>
</body>
</html>`;

  return c.html(html);
});

export { app as docsRouter };
