import { Hono } from "hono";
import { sql } from "../db/connection.js";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import crypto from "crypto";

const app = new Hono();

// --- Session store (in-memory, survives across requests) ---
const sessions = new Map<string, { username: string; avatar: string; expiresAt: number }>();

// Clean expired sessions periodically
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (s.expiresAt < now) sessions.delete(id);
  }
}, 60_000);

const GITHUB_CLIENT_ID = () => process.env.GITHUB_CLIENT_ID || "";
const GITHUB_CLIENT_SECRET = () => process.env.GITHUB_CLIENT_SECRET || "";
const ALLOWED_USERS = () => (process.env.DASHBOARD_ALLOWED_USERS || "").split(",").map(u => u.trim().toLowerCase());
const SESSION_MAX_AGE = 7 * 24 * 60 * 60; // 7 days in seconds

// --- Auth helpers ---
function getSession(c: any): { username: string; avatar: string } | null {
  const sessionId = getCookie(c, "ci_session");
  if (!sessionId) return null;
  const session = sessions.get(sessionId);
  if (!session || session.expiresAt < Date.now()) {
    if (session) sessions.delete(sessionId);
    return null;
  }
  return session;
}

// --- OAuth flow ---

// Step 1: Redirect to GitHub
app.get("/login", (c) => {
  const state = crypto.randomBytes(16).toString("hex");
  setCookie(c, "ci_oauth_state", state, { httpOnly: true, secure: true, sameSite: "Lax", maxAge: 300, path: "/dashboard" });
  const params = new URLSearchParams({
    client_id: GITHUB_CLIENT_ID(),
    redirect_uri: `${new URL(c.req.url).origin}/dashboard/callback`,
    scope: "read:user",
    state,
  });
  return c.redirect(`https://github.com/login/oauth/authorize?${params}`);
});

// Step 2: GitHub callback
app.get("/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  const savedState = getCookie(c, "ci_oauth_state");

  if (!code || !state || state !== savedState) {
    return c.html("<h1>OAuth error: invalid state</h1><p><a href='/dashboard'>Try again</a></p>", 400);
  }
  deleteCookie(c, "ci_oauth_state", { path: "/dashboard" });

  // Exchange code for access token
  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_id: GITHUB_CLIENT_ID(),
      client_secret: GITHUB_CLIENT_SECRET(),
      code,
    }),
  });
  const tokenData = await tokenRes.json() as any;
  if (!tokenData.access_token) {
    return c.html("<h1>OAuth error: failed to get token</h1><p><a href='/dashboard'>Try again</a></p>", 400);
  }

  // Get user info
  const userRes = await fetch("https://api.github.com/user", {
    headers: { Authorization: `Bearer ${tokenData.access_token}`, "User-Agent": "CentralIntelligence" },
  });
  const user = await userRes.json() as any;
  const username = (user.login || "").toLowerCase();

  // Check if user is allowed
  if (!ALLOWED_USERS().includes(username)) {
    return c.html(`<h1>Access denied</h1><p>User <b>${user.login}</b> is not authorized to access this dashboard.</p><p><a href='/dashboard'>Back</a></p>`, 403);
  }

  // Create session
  const sessionId = crypto.randomBytes(32).toString("hex");
  sessions.set(sessionId, {
    username: user.login,
    avatar: user.avatar_url || "",
    expiresAt: Date.now() + SESSION_MAX_AGE * 1000,
  });
  setCookie(c, "ci_session", sessionId, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    maxAge: SESSION_MAX_AGE,
    path: "/",
  });

  return c.redirect("/dashboard");
});

// Logout
app.get("/logout", (c) => {
  const sessionId = getCookie(c, "ci_session");
  if (sessionId) {
    sessions.delete(sessionId);
    deleteCookie(c, "ci_session", { path: "/" });
  }
  return c.redirect("/dashboard");
});

// --- API endpoint (session-protected) ---
app.get("/api/stats", async (c) => {
  const session = getSession(c);
  if (!session) return c.json({ error: "Unauthorized" }, 401);

  const [overview] = await sql`
    SELECT
      (SELECT COUNT(*)::int FROM api_keys WHERE revoked_at IS NULL) AS total_keys,
      (SELECT COUNT(*)::int FROM memories WHERE deleted_at IS NULL) AS total_memories,
      (SELECT COUNT(DISTINCT agent_id)::int FROM memories WHERE deleted_at IS NULL) AS total_agents,
      (SELECT COUNT(*)::int FROM usage_events WHERE created_at > now() - interval '24 hours') AS events_24h,
      (SELECT COALESCE(SUM(tokens), 0)::int FROM usage_events WHERE created_at > now() - interval '24 hours') AS tokens_24h,
      (SELECT COUNT(*)::int FROM usage_events WHERE created_at > now() - interval '7 days') AS events_7d
  `;

  const scopeBreakdown = await sql`
    SELECT scope, COUNT(*)::int AS count
    FROM memories WHERE deleted_at IS NULL
    GROUP BY scope ORDER BY count DESC
  `;

  const eventTypes = await sql`
    SELECT event_type, COUNT(*)::int AS count, COALESCE(SUM(tokens), 0)::int AS tokens
    FROM usage_events
    WHERE created_at > now() - interval '30 days'
    GROUP BY event_type ORDER BY count DESC
  `;

  const dailyUsage = await sql`
    SELECT
      date_trunc('day', created_at)::date AS date,
      COUNT(*)::int AS events,
      COALESCE(SUM(tokens), 0)::int AS tokens
    FROM usage_events
    WHERE created_at > now() - interval '14 days'
    GROUP BY date ORDER BY date
  `;

  const topAgents = await sql`
    SELECT agent_id, COUNT(*)::int AS memories,
      MAX(created_at) AS last_active
    FROM memories WHERE deleted_at IS NULL
    GROUP BY agent_id ORDER BY memories DESC LIMIT 10
  `;

  const recentKeys = await sql`
    SELECT key_prefix, tier, org_id, created_at
    FROM api_keys WHERE revoked_at IS NULL
    ORDER BY created_at DESC LIMIT 10
  `;

  const topTags = await sql`
    SELECT unnest(tags) AS tag, COUNT(*)::int AS count
    FROM memories WHERE deleted_at IS NULL AND array_length(tags, 1) > 0
    GROUP BY tag ORDER BY count DESC LIMIT 15
  `;

  const memoriesGrowth = await sql`
    SELECT
      date_trunc('day', created_at)::date AS date,
      COUNT(*)::int AS new_memories
    FROM memories
    WHERE deleted_at IS NULL AND created_at > now() - interval '14 days'
    GROUP BY date ORDER BY date
  `;

  const tierDistribution = await sql`
    SELECT tier, COUNT(*)::int AS count
    FROM api_keys WHERE revoked_at IS NULL
    GROUP BY tier ORDER BY count DESC
  `;

  return c.json({
    overview,
    scopeBreakdown,
    eventTypes,
    dailyUsage,
    topAgents,
    recentKeys,
    topTags,
    memoriesGrowth,
    tierDistribution,
  });
});

// --- Main dashboard page ---
app.get("/", async (c) => {
  if (!GITHUB_CLIENT_ID()) {
    return c.html("<h1>Dashboard disabled — set GITHUB_CLIENT_ID env var</h1>", 503);
  }

  const session = getSession(c);
  if (!session) {
    return c.html(loginPage());
  }

  return c.html(dashboardPage(session.username, session.avatar));
});

function loginPage(): string {
  return `<!DOCTYPE html>
<html lang="en" style="color-scheme: dark;">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Central Intelligence — Dashboard</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0a0a0f; color: #e0e0e0; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .login { background: #12121a; border: 1px solid #2a2a3a; border-radius: 12px; padding: 40px; max-width: 400px; width: 100%; text-align: center; }
    .login h1 { font-size: 22px; margin-bottom: 8px; }
    .login p { color: #888; margin-bottom: 24px; font-size: 14px; }
    .gh-btn { display: inline-flex; align-items: center; gap: 10px; padding: 12px 24px; background: #24292e; color: white; border: 1px solid #444; border-radius: 8px; font-size: 15px; cursor: pointer; text-decoration: none; font-weight: 600; transition: background 0.2s; }
    .gh-btn:hover { background: #2f363d; }
    .gh-btn svg { width: 20px; height: 20px; fill: white; }
  </style>
</head>
<body>
  <div class="login">
    <h1>🧠 Central Intelligence</h1>
    <p>Sign in with GitHub to access the dashboard.</p>
    <a href="/dashboard/login" class="gh-btn">
      <svg viewBox="0 0 16 16"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"></path></svg>
      Sign in with GitHub
    </a>
  </div>
</body>
</html>`;
}

function dashboardPage(username: string, avatar: string): string {
  return `<!DOCTYPE html>
<html lang="en" style="color-scheme: dark;">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Central Intelligence — Dashboard</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0a0a0f; color: #e0e0e0; }
    .header { background: #12121a; border-bottom: 1px solid #1e1e2e; padding: 16px 24px; display: flex; align-items: center; justify-content: space-between; }
    .header h1 { font-size: 18px; font-weight: 600; }
    .header h1 span { color: #6366f1; }
    .header-right { display: flex; align-items: center; gap: 12px; }
    .header .refresh { background: #1e1e2e; border: 1px solid #2a2a3a; color: #888; padding: 8px 16px; border-radius: 6px; cursor: pointer; font-size: 13px; }
    .header .refresh:hover { color: #e0e0e0; border-color: #6366f1; }
    .user-info { display: flex; align-items: center; gap: 8px; font-size: 13px; color: #888; }
    .user-info img { width: 28px; height: 28px; border-radius: 50%; }
    .user-info a { color: #666; text-decoration: none; font-size: 12px; }
    .user-info a:hover { color: #f87171; }
    .container { max-width: 1200px; margin: 0 auto; padding: 24px; }
    .metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; margin-bottom: 24px; }
    .metric { background: #12121a; border: 1px solid #1e1e2e; border-radius: 10px; padding: 20px; }
    .metric .label { font-size: 12px; color: #888; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px; }
    .metric .value { font-size: 28px; font-weight: 700; }
    .metric .sub { font-size: 12px; color: #666; margin-top: 4px; }
    .metric .value.purple { color: #6366f1; }
    .metric .value.green { color: #22c55e; }
    .metric .value.amber { color: #f59e0b; }
    .metric .value.blue { color: #3b82f6; }
    .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 16px; }
    .grid-3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 16px; margin-bottom: 16px; }
    @media (max-width: 800px) { .grid-2, .grid-3 { grid-template-columns: 1fr; } }
    .panel { background: #12121a; border: 1px solid #1e1e2e; border-radius: 10px; padding: 20px; }
    .panel h2 { font-size: 14px; font-weight: 600; margin-bottom: 16px; color: #ccc; }
    .bar-chart { display: flex; flex-direction: column; gap: 8px; }
    .bar-row { display: flex; align-items: center; gap: 10px; }
    .bar-label { font-size: 12px; color: #888; min-width: 70px; text-align: right; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .bar-track { flex: 1; height: 22px; background: #1a1a2e; border-radius: 4px; overflow: hidden; }
    .bar-fill { height: 100%; border-radius: 4px; transition: width 0.5s ease; min-width: 2px; }
    .bar-fill.purple { background: linear-gradient(90deg, #6366f1, #818cf8); }
    .bar-fill.green { background: linear-gradient(90deg, #22c55e, #4ade80); }
    .bar-fill.blue { background: linear-gradient(90deg, #3b82f6, #60a5fa); }
    .bar-fill.amber { background: linear-gradient(90deg, #f59e0b, #fbbf24); }
    .bar-value { font-size: 12px; color: #aaa; min-width: 40px; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th { text-align: left; color: #666; font-weight: 500; padding: 8px 12px; border-bottom: 1px solid #1e1e2e; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; }
    td { padding: 8px 12px; border-bottom: 1px solid #141420; color: #bbb; }
    tr:last-child td { border-bottom: none; }
    .tags { display: flex; flex-wrap: wrap; gap: 8px; }
    .tag { background: #1a1a2e; border: 1px solid #2a2a3a; color: #818cf8; padding: 4px 10px; border-radius: 20px; font-size: 12px; }
    .tag .count { color: #666; margin-left: 4px; }
    .loading { text-align: center; padding: 40px; color: #666; }
    .spinner { display: inline-block; width: 24px; height: 24px; border: 2px solid #2a2a3a; border-top-color: #6366f1; border-radius: 50%; animation: spin 0.8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .updated { text-align: center; color: #444; font-size: 11px; padding: 16px; }
  </style>
</head>
<body>
  <div class="header">
    <h1>🧠 Central <span>Intelligence</span> — Dashboard</h1>
    <div class="header-right">
      <button class="refresh" onclick="loadData()">↻ Refresh</button>
      <div class="user-info">
        ${avatar ? `<img src="${avatar}" alt="">` : ""}
        <span>${username}</span>
        <a href="/dashboard/logout">Logout</a>
      </div>
    </div>
  </div>
  <div class="container" id="app">
    <div class="loading"><div class="spinner"></div><p style="margin-top:12px">Loading dashboard...</p></div>
  </div>

  <script>
    const API = '/dashboard/api/stats';

    async function loadData() {
      try {
        const res = await fetch(API, { credentials: 'same-origin' });
        if (res.status === 401) { window.location.href = '/dashboard'; return; }
        const data = await res.json();
        render(data);
      } catch (e) {
        document.getElementById('app').innerHTML = '<div class="loading">Failed to load data. <button onclick="loadData()" style="color:#6366f1;background:none;border:none;cursor:pointer;">Retry</button></div>';
      }
    }

    function render(d) {
      const o = d.overview;
      const app = document.getElementById('app');

      app.innerHTML = \`
        <div class="metrics">
          <div class="metric">
            <div class="label">API Keys</div>
            <div class="value purple">\${o.total_keys}</div>
            <div class="sub">Active keys</div>
          </div>
          <div class="metric">
            <div class="label">Memories</div>
            <div class="value green">\${o.total_memories}</div>
            <div class="sub">Stored</div>
          </div>
          <div class="metric">
            <div class="label">Agents</div>
            <div class="value blue">\${o.total_agents}</div>
            <div class="sub">Unique agents</div>
          </div>
          <div class="metric">
            <div class="label">Events (24h)</div>
            <div class="value amber">\${o.events_24h}</div>
            <div class="sub">\${(o.tokens_24h || 0).toLocaleString()} tokens</div>
          </div>
          <div class="metric">
            <div class="label">Events (7d)</div>
            <div class="value">\${o.events_7d}</div>
            <div class="sub">Last 7 days</div>
          </div>
        </div>

        <div class="grid-2">
          <div class="panel">
            <h2>📊 Daily API Events (14d)</h2>
            <div class="bar-chart">\${dailyChart(d.dailyUsage, 'events', 'purple')}</div>
            \${d.dailyUsage.length === 0 ? '<p style="color:#666;font-size:13px;text-align:center;padding:20px;">No events yet</p>' : ''}
          </div>
          <div class="panel">
            <h2>📈 New Memories (14d)</h2>
            <div class="bar-chart">\${dailyChart(d.memoriesGrowth, 'new_memories', 'green')}</div>
            \${d.memoriesGrowth.length === 0 ? '<p style="color:#666;font-size:13px;text-align:center;padding:20px;">No memories yet</p>' : ''}
          </div>
        </div>

        <div class="grid-3">
          <div class="panel">
            <h2>🔧 Event Types (30d)</h2>
            <div class="bar-chart">\${barChart(d.eventTypes, 'event_type', 'count', 'blue')}</div>
            \${d.eventTypes.length === 0 ? '<p style="color:#666;font-size:13px;text-align:center;padding:20px;">No events yet</p>' : ''}
          </div>
          <div class="panel">
            <h2>🔒 Memory Scopes</h2>
            <div class="bar-chart">\${barChart(d.scopeBreakdown, 'scope', 'count', 'purple')}</div>
            \${d.scopeBreakdown.length === 0 ? '<p style="color:#666;font-size:13px;text-align:center;padding:20px;">No memories yet</p>' : ''}
          </div>
          <div class="panel">
            <h2>💳 Tier Distribution</h2>
            <div class="bar-chart">\${barChart(d.tierDistribution, 'tier', 'count', 'amber')}</div>
          </div>
        </div>

        <div class="grid-2">
          <div class="panel">
            <h2>🤖 Top Agents</h2>
            <table>
              <tr><th>Agent</th><th>Memories</th><th>Last Active</th></tr>
              \${d.topAgents.map(a => \`<tr><td>\${esc(a.agent_id)}</td><td>\${a.memories}</td><td>\${ago(a.last_active)}</td></tr>\`).join('')}
            </table>
            \${d.topAgents.length === 0 ? '<p style="color:#666;font-size:13px;text-align:center;padding:20px;">No agents yet</p>' : ''}
          </div>
          <div class="panel">
            <h2>🔑 Recent Signups</h2>
            <table>
              <tr><th>Key</th><th>Tier</th><th>Org</th><th>Signed Up</th></tr>
              \${d.recentKeys.map(k => \`<tr><td><code>\${esc(k.key_prefix)}...</code></td><td>\${esc(k.tier)}</td><td>\${esc(k.org_id || '—')}</td><td>\${ago(k.created_at)}</td></tr>\`).join('')}
            </table>
          </div>
        </div>

        <div class="panel" style="margin-bottom:16px">
          <h2>🏷️ Popular Tags</h2>
          <div class="tags">
            \${d.topTags.map(t => \`<span class="tag">\${esc(t.tag)} <span class="count">×\${t.count}</span></span>\`).join('')}
          </div>
          \${d.topTags.length === 0 ? '<p style="color:#666;font-size:13px;text-align:center;padding:20px;">No tagged memories yet</p>' : ''}
        </div>

        <div class="updated">Last updated: \${new Date().toLocaleString()}</div>
      \`;
    }

    function barChart(data, labelKey, valueKey, color) {
      if (!data || data.length === 0) return '';
      const max = Math.max(...data.map(d => d[valueKey]), 1);
      return data.map(d => \`
        <div class="bar-row">
          <span class="bar-label">\${esc(String(d[labelKey]))}</span>
          <div class="bar-track"><div class="bar-fill \${color}" style="width:\${(d[valueKey]/max*100).toFixed(1)}%"></div></div>
          <span class="bar-value">\${d[valueKey].toLocaleString()}</span>
        </div>
      \`).join('');
    }

    function dailyChart(data, valueKey, color) {
      if (!data || data.length === 0) return '';
      const max = Math.max(...data.map(d => d[valueKey]), 1);
      return data.map(d => {
        const dateStr = new Date(d.date).toLocaleDateString('en', { month: 'short', day: 'numeric' });
        return \`
          <div class="bar-row">
            <span class="bar-label">\${dateStr}</span>
            <div class="bar-track"><div class="bar-fill \${color}" style="width:\${(d[valueKey]/max*100).toFixed(1)}%"></div></div>
            <span class="bar-value">\${d[valueKey].toLocaleString()}</span>
          </div>
        \`;
      }).join('');
    }

    function ago(ts) {
      const d = Date.now() - new Date(ts).getTime();
      if (d < 60000) return 'just now';
      if (d < 3600000) return Math.floor(d/60000) + 'm ago';
      if (d < 86400000) return Math.floor(d/3600000) + 'h ago';
      return Math.floor(d/86400000) + 'd ago';
    }

    function esc(s) {
      const el = document.createElement('span');
      el.textContent = s;
      return el.innerHTML;
    }

    loadData();
    setInterval(loadData, 60000);
  </script>
</body>
</html>`;
}

export { app as dashboardRouter };
