import { Hono } from "hono";
import { buildOpenApiSpec, buildLegacyApiSpec } from "../openapi.js";

const app = new Hono();

// Single source of truth: schemas live in route files, registered in ../openapi.ts
const openApiSpec = buildOpenApiSpec();
const API_SPEC = buildLegacyApiSpec();

// CORS for /docs/* so the landing page (centralintelligence.online/vt220/docs) can fetch.
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Cache-Control": "public, max-age=60",
};

app.options("/json", (c) => {
  Object.entries(corsHeaders).forEach(([k, v]) => c.header(k, v));
  return c.body(null, 204);
});

app.options("/openapi.json", (c) => {
  Object.entries(corsHeaders).forEach(([k, v]) => c.header(k, v));
  return c.body(null, 204);
});

// Legacy proprietary shape — derived from the OpenAPI spec at startup
app.get("/json", (c) => {
  Object.entries(corsHeaders).forEach(([k, v]) => c.header(k, v));
  return c.json(API_SPEC);
});

// OpenAPI 3.1 (industry standard: ChatGPT Custom GPTs, Swagger, Postman, VT220 docs page)
app.get("/openapi.json", (c) => {
  Object.entries(corsHeaders).forEach(([k, v]) => c.header(k, v));
  return c.json(openApiSpec);
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
