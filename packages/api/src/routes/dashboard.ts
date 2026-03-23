import { Hono } from "hono";
import { sql } from "../db/connection.js";

const app = new Hono();

// Simple admin auth via query param or header
function checkAdmin(c: any): boolean {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) return false;
  const token = c.req.query("token") || c.req.header("X-Admin-Token");
  return token === secret;
}

// GET /dashboard/api/stats — JSON stats for the dashboard
app.get("/api/stats", async (c) => {
  if (!checkAdmin(c)) return c.json({ error: "Unauthorized" }, 401);

  // Overview
  const [overview] = await sql`
    SELECT
      (SELECT COUNT(*)::int FROM api_keys WHERE revoked_at IS NULL) AS total_keys,
      (SELECT COUNT(*)::int FROM memories WHERE deleted_at IS NULL) AS total_memories,
      (SELECT COUNT(DISTINCT agent_id)::int FROM memories WHERE deleted_at IS NULL) AS total_agents,
      (SELECT COUNT(*)::int FROM usage_events WHERE created_at > now() - interval '24 hours') AS events_24h,
      (SELECT COALESCE(SUM(tokens), 0)::int FROM usage_events WHERE created_at > now() - interval '24 hours') AS tokens_24h,
      (SELECT COUNT(*)::int FROM usage_events WHERE created_at > now() - interval '7 days') AS events_7d
  `;

  // Memories by scope
  const scopeBreakdown = await sql`
    SELECT scope, COUNT(*)::int AS count
    FROM memories WHERE deleted_at IS NULL
    GROUP BY scope ORDER BY count DESC
  `;

  // Event types breakdown (30d)
  const eventTypes = await sql`
    SELECT event_type, COUNT(*)::int AS count, COALESCE(SUM(tokens), 0)::int AS tokens
    FROM usage_events
    WHERE created_at > now() - interval '30 days'
    GROUP BY event_type ORDER BY count DESC
  `;

  // Daily usage (last 14 days)
  const dailyUsage = await sql`
    SELECT
      date_trunc('day', created_at)::date AS date,
      COUNT(*)::int AS events,
      COALESCE(SUM(tokens), 0)::int AS tokens
    FROM usage_events
    WHERE created_at > now() - interval '14 days'
    GROUP BY date ORDER BY date
  `;

  // Top agents by memory count
  const topAgents = await sql`
    SELECT agent_id, COUNT(*)::int AS memories,
      MAX(created_at) AS last_active
    FROM memories WHERE deleted_at IS NULL
    GROUP BY agent_id ORDER BY memories DESC LIMIT 10
  `;

  // Recent signups
  const recentKeys = await sql`
    SELECT key_prefix, tier, org_id, created_at
    FROM api_keys WHERE revoked_at IS NULL
    ORDER BY created_at DESC LIMIT 10
  `;

  // Top tags
  const topTags = await sql`
    SELECT unnest(tags) AS tag, COUNT(*)::int AS count
    FROM memories WHERE deleted_at IS NULL AND array_length(tags, 1) > 0
    GROUP BY tag ORDER BY count DESC LIMIT 15
  `;

  // Memories growth (last 14 days)
  const memoriesGrowth = await sql`
    SELECT
      date_trunc('day', created_at)::date AS date,
      COUNT(*)::int AS new_memories
    FROM memories
    WHERE deleted_at IS NULL AND created_at > now() - interval '14 days'
    GROUP BY date ORDER BY date
  `;

  // Tier distribution
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

// GET /dashboard — HTML dashboard
app.get("/", async (c) => {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) {
    return c.html("<h1>Dashboard disabled — set ADMIN_SECRET env var</h1>", 503);
  }

  const token = c.req.query("token");
  if (!token) {
    return c.html(loginPage(), 200);
  }
  if (token !== secret) {
    return c.html("<h1>Invalid token</h1>", 401);
  }

  return c.html(dashboardPage(token));
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
    .login { background: #12121a; border: 1px solid #2a2a3a; border-radius: 12px; padding: 40px; max-width: 400px; width: 100%; }
    .login h1 { font-size: 22px; margin-bottom: 8px; }
    .login p { color: #888; margin-bottom: 24px; font-size: 14px; }
    .login input { width: 100%; padding: 12px 16px; background: #1a1a2e; border: 1px solid #2a2a3a; border-radius: 8px; color: #e0e0e0; font-size: 14px; margin-bottom: 16px; }
    .login button { width: 100%; padding: 12px; background: #6366f1; color: white; border: none; border-radius: 8px; font-size: 14px; cursor: pointer; font-weight: 600; }
    .login button:hover { background: #5558e6; }
  </style>
</head>
<body>
  <div class="login">
    <h1>🧠 Central Intelligence</h1>
    <p>Enter your admin token to access the dashboard.</p>
    <form method="get">
      <input type="password" name="token" placeholder="Admin token" required autofocus>
      <button type="submit">Sign In</button>
    </form>
  </div>
</body>
</html>`;
}

function dashboardPage(token: string): string {
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
    .header .refresh { background: #1e1e2e; border: 1px solid #2a2a3a; color: #888; padding: 8px 16px; border-radius: 6px; cursor: pointer; font-size: 13px; }
    .header .refresh:hover { color: #e0e0e0; border-color: #6366f1; }
    .container { max-width: 1200px; margin: 0 auto; padding: 24px; }

    /* Metric cards */
    .metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; margin-bottom: 24px; }
    .metric { background: #12121a; border: 1px solid #1e1e2e; border-radius: 10px; padding: 20px; }
    .metric .label { font-size: 12px; color: #888; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px; }
    .metric .value { font-size: 28px; font-weight: 700; }
    .metric .sub { font-size: 12px; color: #666; margin-top: 4px; }
    .metric .value.purple { color: #6366f1; }
    .metric .value.green { color: #22c55e; }
    .metric .value.amber { color: #f59e0b; }
    .metric .value.blue { color: #3b82f6; }

    /* Panels */
    .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 16px; }
    .grid-3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 16px; margin-bottom: 16px; }
    @media (max-width: 800px) { .grid-2, .grid-3 { grid-template-columns: 1fr; } }
    .panel { background: #12121a; border: 1px solid #1e1e2e; border-radius: 10px; padding: 20px; }
    .panel h2 { font-size: 14px; font-weight: 600; margin-bottom: 16px; color: #ccc; }

    /* Charts (simple CSS bar charts) */
    .bar-chart { display: flex; flex-direction: column; gap: 8px; }
    .bar-row { display: flex; align-items: center; gap: 10px; }
    .bar-label { font-size: 12px; color: #888; min-width: 70px; text-align: right; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .bar-track { flex: 1; height: 22px; background: #1a1a2e; border-radius: 4px; overflow: hidden; position: relative; }
    .bar-fill { height: 100%; border-radius: 4px; transition: width 0.5s ease; min-width: 2px; }
    .bar-fill.purple { background: linear-gradient(90deg, #6366f1, #818cf8); }
    .bar-fill.green { background: linear-gradient(90deg, #22c55e, #4ade80); }
    .bar-fill.blue { background: linear-gradient(90deg, #3b82f6, #60a5fa); }
    .bar-fill.amber { background: linear-gradient(90deg, #f59e0b, #fbbf24); }
    .bar-value { font-size: 12px; color: #aaa; min-width: 40px; }

    /* Table */
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th { text-align: left; color: #666; font-weight: 500; padding: 8px 12px; border-bottom: 1px solid #1e1e2e; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; }
    td { padding: 8px 12px; border-bottom: 1px solid #141420; color: #bbb; }
    tr:last-child td { border-bottom: none; }

    /* Tags */
    .tags { display: flex; flex-wrap: wrap; gap: 8px; }
    .tag { background: #1a1a2e; border: 1px solid #2a2a3a; color: #818cf8; padding: 4px 10px; border-radius: 20px; font-size: 12px; }
    .tag .count { color: #666; margin-left: 4px; }

    /* Loading */
    .loading { text-align: center; padding: 40px; color: #666; }
    .spinner { display: inline-block; width: 24px; height: 24px; border: 2px solid #2a2a3a; border-top-color: #6366f1; border-radius: 50%; animation: spin 0.8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* Timestamp */
    .updated { text-align: center; color: #444; font-size: 11px; padding: 16px; }
  </style>
</head>
<body>
  <div class="header">
    <h1>🧠 Central <span>Intelligence</span> — Dashboard</h1>
    <button class="refresh" onclick="loadData()">↻ Refresh</button>
  </div>
  <div class="container" id="app">
    <div class="loading"><div class="spinner"></div><p style="margin-top:12px">Loading dashboard...</p></div>
  </div>

  <script>
    const TOKEN = ${JSON.stringify(token)};
    const API = '/dashboard/api/stats?token=' + encodeURIComponent(TOKEN);

    async function loadData() {
      try {
        const res = await fetch(API);
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
        <!-- Top metrics -->
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

        <!-- Charts row -->
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

        <!-- Breakdown row -->
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

        <!-- Tables row -->
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

        <!-- Tags -->
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
    // Auto-refresh every 60s
    setInterval(loadData, 60000);
  </script>
</body>
</html>`;
}

export { app as dashboardRouter };
