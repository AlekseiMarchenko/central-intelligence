import { createServer, IncomingMessage, ServerResponse } from "http";
import { parseAllFiles } from "../file-sources.js";
import { getAllMemories, getDb } from "../db.js";
import { computeHealth } from "../health.js";
import { detectDuplicates, computeFreshness } from "../analysis.js";
import { embed } from "../embeddings.js";

interface DashboardOptions {
  port?: string;
}

export async function dashboardCommand(options: DashboardOptions): Promise<void> {
  const chalk = (await import("chalk")).default;
  const port = parseInt(options.port || "3141", 10);

  const server = createServer(async (req, res) => {
    // API routes
    if (req.url === "/api/memories" && req.method === "GET") {
      return handleGetMemories(res);
    }
    if (req.url === "/api/memories/delete" && req.method === "POST") {
      return handleDeleteMemories(req, res);
    }
    if (req.url?.startsWith("/api/memories/search") && req.method === "GET") {
      const url = new URL(req.url, `http://localhost:${port}`);
      const query = url.searchParams.get("q") || "";
      const mode = url.searchParams.get("mode") || "smart"; // smart | keyword
      return handleSearchMemories(res, query, mode);
    }
    if (req.url === "/api/memories/tags" && req.method === "GET") {
      return handleGetTags(res);
    }
    if (req.url === "/api/memories/transfer" && req.method === "POST") {
      return handleTransfer(req, res);
    }

    // Dashboard HTML
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(generateDashboardHtml());
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(chalk.red(`Port ${port} is already in use. Try: ci dashboard --port ${port + 1}`));
      process.exit(1);
    }
    throw err;
  });

  server.listen(port, "127.0.0.1", () => {
    const url = `http://localhost:${port}`;
    console.log(chalk.bold("\nCI Local Pro — Dashboard\n"));
    console.log(`  ${chalk.green("→")} ${url}`);
    console.log(`  Press ${chalk.bold("Enter")} to open in browser, or ${chalk.dim("Ctrl+C")} to stop.\n`);

    // Wait for Enter before opening browser
    process.stdin.setRawMode?.(false);
    process.stdin.resume();
    process.stdin.once("data", () => {
      import("child_process").then(({ exec }) => {
        const cmd = process.platform === "darwin" ? `open "${url}"`
          : process.platform === "win32" ? `start "${url}"`
          : `xdg-open "${url}"`;
        exec(cmd);
      });
      console.log(chalk.dim("  Opened in browser. Press Ctrl+C to stop.\n"));
    });
  });
}

function parseTagsArray(tagsStr: string): string[] {
  try { return JSON.parse(tagsStr); } catch { return []; }
}

function extractProject(tags: string[]): string | null {
  const chatTag = tags.find((t) => t.startsWith("chat:"));
  if (chatTag) return chatTag.slice(5);
  return null;
}

function buildMemoryList() {
  let dbMemories: ReturnType<typeof getAllMemories> = [];
  try { dbMemories = getAllMemories(); } catch { dbMemories = []; }
  const { entries: fileEntries, files, warnings } = parseAllFiles();

  const all = [
    ...dbMemories.map((m) => {
      const tags = parseTagsArray(m.tags);
      return {
        id: m.id,
        content: m.content,
        source: "db" as const,
        source_path: "~/.central-intelligence/memories.db",
        freshness_score: computeFreshness(m.created_at),
        duplicate_group: null as string | null,
        created_at: m.created_at,
        tags: m.tags,
        tags_array: tags,
        project: extractProject(tags),
        embedding: m.embedding,
        deletable: true,
      };
    }),
    ...fileEntries.map((e) => ({
      id: e.content_hash,
      content: e.content,
      source: e.source,
      source_path: e.source_path,
      freshness_score: 1.0,
      duplicate_group: null as string | null,
      created_at: new Date().toISOString(),
      tags: "[]",
      tags_array: [] as string[],
      project: e.source as string,
      embedding: null as Buffer | null,
      deletable: false,
    })),
  ];

  const withDuplicates = detectDuplicates(all);
  const health = computeHealth(withDuplicates, fileEntries);
  return { memories: withDuplicates, health, files, warnings };
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

function embeddingFromBuffer(buf: Buffer | Uint8Array): number[] {
  return Array.from(new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4));
}

function handleGetMemories(res: ServerResponse): void {
  try {
    const data = buildMemoryList();
    const stripped = data.memories.map(({ embedding, ...m }) => m);
    json(res, { ...data, memories: stripped });
  } catch (err: any) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err.message }));
  }
}

function handleDeleteMemories(req: IncomingMessage, res: ServerResponse): void {
  let body = "";
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", () => {
    try {
      const { ids } = JSON.parse(body) as { ids: string[] };
      if (!ids || !Array.isArray(ids) || ids.length === 0) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "No ids provided" }));
        return;
      }

      const db = getDb();
      const stmt = db.prepare("UPDATE memories SET deleted_at = datetime('now') WHERE id = ? AND deleted_at IS NULL");
      let deleted = 0;
      for (const id of ids) {
        const result = stmt.run(id);
        if (result.changes > 0) deleted++;
      }

      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ deleted, requested: ids.length }));
    } catch (err: any) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
  });
}

async function handleSearchMemories(res: ServerResponse, query: string, mode: string): Promise<void> {
  try {
    const data = buildMemoryList();
    if (!query) {
      const stripped = data.memories.map(({ embedding, ...m }) => m);
      json(res, { ...data, memories: stripped });
      return;
    }

    if (mode === "keyword") {
      // Simple keyword search
      const q = query.toLowerCase();
      const filtered = data.memories
        .filter((m) => m.content.toLowerCase().includes(q) || m.source.includes(q) || m.tags.toLowerCase().includes(q) || (m.project && m.project.toLowerCase().includes(q)))
        .map(({ embedding, ...m }) => m);
      json(res, { ...data, memories: filtered });
      return;
    }

    // Smart search: embed the query and rank by cosine similarity
    let queryVec: number[];
    try {
      queryVec = await embed(query);
    } catch {
      // Embedding failed, fall back to keyword
      const q = query.toLowerCase();
      const filtered = data.memories
        .filter((m) => m.content.toLowerCase().includes(q) || (m.project && m.project.toLowerCase().includes(q)))
        .map(({ embedding, ...m }) => m);
      json(res, { ...data, memories: filtered });
      return;
    }

    // Score each memory by semantic similarity
    const scored = data.memories
      .map((m) => {
        let similarity = 0;
        if (m.embedding) {
          try {
            const memVec = embeddingFromBuffer(m.embedding);
            similarity = cosineSimilarity(queryVec, memVec);
          } catch {}
        }
        // Also boost keyword matches
        const q = query.toLowerCase();
        const keywordHit = m.content.toLowerCase().includes(q) || (m.project && m.project.toLowerCase().includes(q)) ? 0.15 : 0;
        return { ...m, similarity: similarity + keywordHit };
      })
      .filter((m) => m.similarity > 0.25) // threshold
      .sort((a, b) => b.similarity - a.similarity)
      .map(({ embedding, ...m }) => m);

    json(res, { ...data, memories: scored, search_mode: "semantic" });
  } catch (err: any) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err.message }));
  }
}

function handleGetTags(res: ServerResponse): void {
  try {
    const data = buildMemoryList();
    const projectCounts = new Map<string, number>();
    const sourceCounts = new Map<string, number>();

    for (const m of data.memories) {
      const p = m.project || "(untagged)";
      projectCounts.set(p, (projectCounts.get(p) || 0) + 1);
      sourceCounts.set(m.source, (sourceCounts.get(m.source) || 0) + 1);
    }

    json(res, {
      projects: [...projectCounts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
      sources: [...sourceCounts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    });
  } catch (err: any) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err.message }));
  }
}

function handleTransfer(req: IncomingMessage, res: ServerResponse): void {
  let body = "";
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", async () => {
    try {
      const { memories, project } = JSON.parse(body) as { memories: string[]; project: string };
      if (!memories || !Array.isArray(memories) || memories.length === 0) {
        json(res, { error: "No memories provided", imported: 0, skipped: 0 });
        return;
      }

      const db = getDb();
      const { v4: uuid } = await import("uuid");

      let embedFn: ((text: string) => Promise<number[]>) | null = null;
      try {
        const mod = await import("../embeddings.js");
        embedFn = mod.embed;
      } catch {}

      const checkStmt = db.prepare(
        "SELECT id FROM memories WHERE content = ? AND deleted_at IS NULL LIMIT 1"
      );
      const insertStmt = db.prepare(
        `INSERT INTO memories (id, agent_id, user_id, scope, content, tags, embedding, created_at)
         VALUES (?, ?, NULL, 'user', ?, ?, ?, datetime('now'))`
      );

      let imported = 0;
      let skipped = 0;

      for (const content of memories) {
        if (!content || content.length < 5) continue;

        const existing = checkStmt.get(content) as { id: string } | undefined;
        if (existing) { skipped++; continue; }

        let embBuf: Buffer | null = null;
        if (embedFn) {
          try {
            const vec = await embedFn(content);
            embBuf = Buffer.from(new Float32Array(vec).buffer);
          } catch {}
        }

        const tags = JSON.stringify(["chatgpt-transfer", `chat:${project.slice(0, 50)}`]);
        insertStmt.run(uuid(), "chatgpt-transfer", content, tags, embBuf);
        imported++;
      }

      json(res, { imported, skipped, project });
    } catch (err: any) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
  });
}

function json(res: ServerResponse, data: any): void {
  res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(data));
}

function generateDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CI Local Pro — Memory Dashboard</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0d1117; color: #c9d1d9; padding: 24px; }
    h1 { color: #fafafa; margin-bottom: 8px; font-size: 24px; }
    h1 span { color: #6d5aff; }
    .subtitle { color: #8b949e; margin-bottom: 24px; }
    .toolbar { display: flex; gap: 12px; margin-bottom: 16px; align-items: center; flex-wrap: wrap; }
    .search-box { background: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 8px 12px; color: #c9d1d9; font-size: 14px; width: 300px; outline: none; }
    .search-box:focus { border-color: #58a6ff; }
    .btn { padding: 8px 16px; border-radius: 6px; border: 1px solid #30363d; background: #21262d; color: #c9d1d9; cursor: pointer; font-size: 13px; }
    .btn:hover { background: #30363d; }
    .btn-danger { border-color: #f8514933; color: #f85149; }
    .btn-danger:hover { background: #f8514922; }
    .btn-danger:disabled { opacity: 0.4; cursor: not-allowed; }
    .btn-primary { border-color: #58a6ff33; color: #58a6ff; }
    .btn-primary:hover { background: #58a6ff22; }
    .score-card { display: inline-block; background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 16px 24px; margin-bottom: 16px; }
    .score-num { font-size: 48px; font-weight: bold; }
    .score-label { color: #8b949e; font-size: 14px; }
    .score-good { color: #3fb950; }
    .score-warn { color: #d29922; }
    .score-bad { color: #f85149; }
    .stats { display: flex; gap: 12px; margin-bottom: 16px; flex-wrap: wrap; }
    .stat { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 10px 14px; min-width: 100px; }
    .stat-num { font-size: 22px; font-weight: bold; color: #58a6ff; }
    .stat-label { font-size: 11px; color: #8b949e; }
    .selection-bar { background: #161b22; border: 1px solid #58a6ff33; border-radius: 6px; padding: 8px 16px; margin-bottom: 12px; display: none; align-items: center; gap: 12px; font-size: 13px; }
    .selection-bar.active { display: flex; }
    table { width: 100%; border-collapse: collapse; background: #161b22; border-radius: 8px; overflow: hidden; }
    th { text-align: left; padding: 8px 12px; background: #21262d; color: #8b949e; font-size: 12px; font-weight: 600; text-transform: uppercase; }
    td { padding: 8px 12px; border-top: 1px solid #21262d; font-size: 14px; }
    td.content-cell { max-width: 500px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    tr.selected { background: #58a6ff11; }
    tr:hover { background: #161b2288; }
    input[type="checkbox"] { accent-color: #58a6ff; width: 16px; height: 16px; cursor: pointer; }
    .tag-fresh { color: #3fb950; }
    .tag-aging { color: #d29922; }
    .tag-stale { color: #f85149; }
    .tag-dup { background: #f8514922; color: #f85149; padding: 2px 6px; border-radius: 4px; font-size: 12px; }
    .tag-source { background: #58a6ff22; color: #58a6ff; padding: 2px 6px; border-radius: 4px; font-size: 12px; }
    .tag-tag { background: #8b949e22; color: #8b949e; padding: 2px 6px; border-radius: 4px; font-size: 11px; margin-left: 4px; }
    .tag-project { background: #a371f722; color: #a371f7; padding: 2px 8px; border-radius: 4px; font-size: 12px; cursor: pointer; }
    .tag-project:hover { background: #a371f744; }
    .project-bar { display: flex; gap: 8px; margin-bottom: 12px; flex-wrap: wrap; align-items: center; }
    .project-chip { background: #161b22; border: 1px solid #30363d; border-radius: 16px; padding: 4px 12px; font-size: 12px; color: #c9d1d9; cursor: pointer; }
    .project-chip:hover { border-color: #a371f7; color: #a371f7; }
    .project-chip.active { border-color: #a371f7; background: #a371f722; color: #a371f7; }
    .project-chip .count { color: #8b949e; margin-left: 4px; }
    .search-mode { font-size: 11px; color: #8b949e; margin-left: 8px; }
    .similarity { font-size: 11px; color: #8b949e; }
    .toast { position: fixed; bottom: 24px; right: 24px; background: #3fb950; color: #0d1117; padding: 12px 20px; border-radius: 8px; font-weight: 600; display: none; z-index: 100; }
    .toast.error { background: #f85149; color: white; }
    .empty { color: #484f58; text-align: center; padding: 40px; }
    .top-bar { display: flex; align-items: center; justify-content: space-between; margin-bottom: 24px; }
    .top-bar-left { }
    .btn-transfer { background: #7c3aed; color: white; border: none; border-radius: 8px; padding: 10px 18px; cursor: pointer; font-size: 14px; font-weight: 600; display: flex; align-items: center; gap: 8px; transition: background 0.15s; }
    .btn-transfer:hover { background: #6d28d9; }
    .btn-transfer svg { width: 16px; height: 16px; }
    .tab-content { display: none; }
    .tab-content.active { display: block; }
    .modal-overlay { display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.7); z-index: 200; align-items: center; justify-content: center; }
    .modal-overlay.active { display: flex; }
    .modal { background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 32px; max-width: 700px; width: 90%; max-height: 90vh; overflow-y: auto; position: relative; }
    .modal-close { position: absolute; top: 12px; right: 16px; background: none; border: none; color: #8b949e; font-size: 24px; cursor: pointer; }
    .modal-close:hover { color: #c9d1d9; }
    .transfer-section { max-width: 700px; }
    .transfer-section h2 { font-size: 18px; margin-bottom: 8px; color: #c9d1d9; }
    .transfer-section p { color: #8b949e; font-size: 14px; margin-bottom: 16px; line-height: 1.6; }
    .prompt-box { background: #0d1117; border: 1px solid #30363d; border-radius: 8px; padding: 16px; font-family: monospace; font-size: 13px; color: #c9d1d9; line-height: 1.6; white-space: pre-wrap; position: relative; margin-bottom: 16px; }
    .prompt-copy { position: absolute; top: 8px; right: 8px; background: #58a6ff; color: #0d1117; border: none; border-radius: 6px; padding: 6px 14px; cursor: pointer; font-size: 12px; font-weight: 600; }
    .prompt-copy:hover { background: #79b8ff; }
    .transfer-steps { display: flex; gap: 16px; margin-bottom: 24px; flex-wrap: wrap; }
    .transfer-step { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 16px; flex: 1; min-width: 200px; }
    .transfer-step-num { display: inline-block; width: 24px; height: 24px; border-radius: 50%; background: #58a6ff22; color: #58a6ff; text-align: center; line-height: 24px; font-size: 12px; font-weight: 700; margin-bottom: 8px; }
    .transfer-step h3 { font-size: 14px; margin-bottom: 4px; }
    .transfer-step p { font-size: 12px; color: #8b949e; margin-bottom: 0; }
  </style>
</head>
<body>
  <div class="top-bar">
    <div class="top-bar-left">
      <h1>Central <span>Intelligence</span></h1>
      <p class="subtitle">Cross-tool memory dashboard</p>
    </div>
    <div style="display:flex;gap:10px;align-items:center;">
      <button class="btn-transfer" onclick="openSync()" style="background:#58a6ff;">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 12v1a3 3 0 003 3h10a3 3 0 003-3v-1M16 6l-4-4-4 4M12 2v13"/></svg>
        Sync to Cloud
      </button>
      <button class="btn-transfer" onclick="openTransfer()">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>
        Transfer from ChatGPT
      </button>
    </div>
  </div>

  <!-- Main content -->
  <div class="toolbar">
    <input class="search-box" type="text" placeholder="Search memories..." id="searchBox" style="flex:1;width:auto;" />
    <button class="btn btn-primary" onclick="selectAllVisible()">Select filtered</button>
    <span class="search-mode" id="searchMode"></span>
  </div>
  <div class="project-bar" id="projectBar"></div>
  <div class="selection-bar" id="selBar">
    <span id="selCount">0 selected</span>
    <button class="btn btn-danger" onclick="deleteSelected()">Delete selected</button>
    <button class="btn" onclick="clearSelection()">Clear</button>
  </div>
  <div id="header"></div>
  <div id="tableWrap"></div>

  <!-- Transfer modal -->
  <div class="modal-overlay" id="transferModal">
    <div class="modal">
      <button class="modal-close" onclick="closeTransfer()">&times;</button>
      <div class="transfer-section">
        <h2>Transfer from ChatGPT</h2>
        <p>Your ChatGPT conversations hold preferences, decisions, and project context. Three steps to bring them here.</p>

        <div class="transfer-steps">
          <div class="transfer-step">
            <div class="transfer-step-num">1</div>
            <h3>Copy the prompt</h3>
            <p>Copy the extraction prompt below.</p>
          </div>
          <div class="transfer-step">
            <div class="transfer-step-num">2</div>
            <h3>Paste in ChatGPT</h3>
            <p>Open the conversation you want. Paste the prompt.</p>
          </div>
          <div class="transfer-step">
            <div class="transfer-step-num">3</div>
            <h3>Paste the output here</h3>
            <p>Copy ChatGPT's response. Paste below. Click Import.</p>
          </div>
        </div>

        <h3 style="margin-bottom:8px;">Step 1: Copy this into ChatGPT</h3>
        <div class="prompt-box" id="extractPrompt">Review our entire conversation. Extract every preference, decision, project detail, architectural choice, and instruction I shared. Ignore questions, debugging, code blocks, and small talk.

Write each as a standalone fact useful to a different AI assistant with zero context. Start each with an action word (Use, Prefer, Always, Never, Deploy, etc).

Output ONLY this format, nothing else:

TRANSFER TO CI:
Project: [name of this conversation as shown in your sidebar]
- [fact 1]
- [fact 2]
- [fact 3]
...<button class="prompt-copy" onclick="copyPrompt()">Copy prompt</button></div>

        <h3 style="margin-top:20px;margin-bottom:8px;">Step 3: Paste ChatGPT's output</h3>
        <textarea id="transferInput" style="width:100%;height:180px;background:#0d1117;border:1px solid #30363d;border-radius:8px;padding:16px;font-family:monospace;font-size:13px;color:#c9d1d9;resize:vertical;" placeholder="Paste the TRANSFER TO CI output from ChatGPT here..."></textarea>
        <div style="margin-top:12px;display:flex;gap:12px;align-items:center;">
          <button onclick="processTransfer()" style="background:#7c3aed;color:white;border:none;border-radius:8px;padding:10px 20px;cursor:pointer;font-size:14px;font-weight:600;">Import memories</button>
          <span id="transferStatus" style="color:#8b949e;font-size:13px;"></span>
        </div>
      </div>
    </div>
  </div>

  <!-- Sync modal -->
  <div class="modal-overlay" id="syncModal">
    <div class="modal">
      <button class="modal-close" onclick="closeSync()">&times;</button>
      <div class="transfer-section">
        <h2>Sync to Cloud Dashboard</h2>
        <p>Upload your local memories to the cloud so you can view them on <a href="https://centralintelligence.online/app" target="_blank" style="color:#58a6ff">centralintelligence.online/app</a> from any device.</p>

        <div class="transfer-steps">
          <div class="transfer-step">
            <div class="transfer-step-num">1</div>
            <h3>Get your API key</h3>
            <p>Sign up at <a href="https://centralintelligence.online/app" target="_blank" style="color:#58a6ff">centralintelligence.online/app</a></p>
          </div>
          <div class="transfer-step">
            <div class="transfer-step-num">2</div>
            <h3>Paste your key</h3>
            <p>Enter the API key from your dashboard email.</p>
          </div>
          <div class="transfer-step">
            <div class="transfer-step-num">3</div>
            <h3>Sync</h3>
            <p>Your memories appear on the cloud dashboard instantly.</p>
          </div>
        </div>

        <div style="margin-bottom:16px;">
          <label style="font-size:12px;color:#8b949e;display:block;margin-bottom:6px;">API Key</label>
          <input type="text" id="syncKeyInput" placeholder="ci_sk_..." style="width:100%;background:#0d1117;border:1px solid #30363d;border-radius:8px;padding:10px 14px;font-family:monospace;font-size:13px;color:#c9d1d9;outline:none;" />
        </div>

        <div style="display:flex;gap:12px;align-items:center;">
          <button onclick="runSync()" id="syncBtn" style="background:#58a6ff;color:#0d1117;border:none;border-radius:8px;padding:10px 20px;cursor:pointer;font-size:14px;font-weight:600;">Sync Now</button>
          <span id="syncStatus" style="color:#8b949e;font-size:13px;"></span>
        </div>
      </div>
    </div>
  </div>

  <div id="toast" class="toast"></div>

  <script>
    let allMemories = [];
    let selected = new Set();
    let currentFilter = '';
    let activeProject = null;
    let lastHealth = null;
    let projects = [];

    // Transfer modal
    function openTransfer() {
      document.getElementById('transferModal').classList.add('active');
    }
    function closeTransfer() {
      document.getElementById('transferModal').classList.remove('active');
    }
    function openSync() {
      document.getElementById('syncModal').classList.add('active');
    }
    function closeSync() {
      document.getElementById('syncModal').classList.remove('active');
    }

    async function runSync() {
      var key = document.getElementById('syncKeyInput').value.trim();
      var status = document.getElementById('syncStatus');
      var btn = document.getElementById('syncBtn');
      if (!key) { status.textContent = 'Enter your API key first.'; status.style.color = '#f85149'; return; }

      btn.disabled = true; btn.textContent = 'Syncing...';
      status.textContent = '';

      try {
        // Get all memories from local
        var res = await fetch('/api/memories');
        var data = await res.json();
        var memories = data.memories || [];
        var synced = 0;

        for (var m of memories) {
          if (!m.deletable) continue; // skip file entries
          var tags = [];
          try { tags = JSON.parse(m.tags || '[]'); } catch {}

          var r = await fetch('https://central-intelligence-api.fly.dev/memories/remember', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
            body: JSON.stringify({ agent_id: m.source || 'synced', content: m.content, tags: tags, scope: m.scope || 'agent' }),
          });
          if (r.ok) synced++;
          else if (r.status === 401) { status.textContent = 'Invalid API key.'; status.style.color = '#f85149'; btn.disabled = false; btn.textContent = 'Sync Now'; return; }

          if (synced % 10 === 0) status.textContent = synced + '/' + memories.length + ' synced...';
        }

        status.textContent = synced + ' memories synced to cloud!';
        status.style.color = '#3fb950';
        btn.textContent = 'Done!';
      } catch (err) {
        status.textContent = 'Sync failed: ' + err.message;
        status.style.color = '#f85149';
        btn.disabled = false;
        btn.textContent = 'Sync Now';
      }
    }

    // Close on overlay click
    document.getElementById('transferModal').addEventListener('click', function(e) {
      if (e.target === this) closeTransfer();
    });
    document.getElementById('syncModal').addEventListener('click', function(e) {
      if (e.target === this) closeSync();
    });
    // Close on Escape
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') { closeTransfer(); closeSync(); }
    });

    function copyPrompt() {
      const text = document.getElementById('extractPrompt').textContent.replace('Copy prompt', '').trim();
      navigator.clipboard.writeText(text).then(() => {
        const btn = document.querySelector('.prompt-copy');
        btn.textContent = 'Copied!';
        btn.style.background = '#3fb950';
        setTimeout(() => { btn.textContent = 'Copy prompt'; btn.style.background = '#58a6ff'; }, 2000);
      });
    }

    async function processTransfer() {
      const input = document.getElementById('transferInput').value.trim();
      const status = document.getElementById('transferStatus');

      if (!input) { status.textContent = 'Paste ChatGPT output first.'; return; }

      // Parse the TRANSFER TO CI format
      const lines = input.split('\\n');
      let projectName = 'ChatGPT Transfer';
      const memories = [];

      for (const line of lines) {
        const projMatch = line.match(/^Project:\\s*(.+)/i);
        if (projMatch) { projectName = projMatch[1].trim(); continue; }
        const memMatch = line.match(/^[\\-\\*]\\s+(.+)/);
        if (memMatch) { memories.push(memMatch[1].trim()); }
      }

      if (memories.length === 0) {
        status.textContent = 'No memories found. Make sure the format starts with "TRANSFER TO CI:" and uses bullet points.';
        status.style.color = '#f85149';
        return;
      }

      status.textContent = 'Importing ' + memories.length + ' memories...';
      status.style.color = '#8b949e';

      try {
        const res = await fetch('/api/memories/transfer', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ memories, project: projectName }),
        });
        const data = await res.json();

        if (data.imported > 0) {
          status.textContent = 'Imported ' + data.imported + ' memories from "' + projectName + '"' + (data.skipped > 0 ? ' (' + data.skipped + ' duplicates skipped)' : '');
          status.style.color = '#3fb950';
          document.getElementById('transferInput').value = '';
          // Refresh memories tab
          fetchAndRender();
        } else {
          status.textContent = 'All ' + data.skipped + ' memories already exist.';
          status.style.color = '#d29922';
        }
      } catch (err) {
        status.textContent = 'Import failed: ' + err.message;
        status.style.color = '#f85149';
      }
    }

    const searchBox = document.getElementById('searchBox');
    let searchTimer;
    searchBox.addEventListener('input', function() {
      clearTimeout(searchTimer);
      const val = this.value;
      searchTimer = setTimeout(() => {
        currentFilter = val;
        activeProject = null;
        fetchAndRender();
      }, 500);
    });

    searchBox.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') selectAllVisible();
    });

    async function fetchAndRender() {
      try {
        const url = currentFilter
          ? '/api/memories/search?q=' + encodeURIComponent(currentFilter) + '&mode=smart'
          : '/api/memories';
        const res = await fetch(url);
        const data = await res.json();
        allMemories = data.memories || [];
        lastHealth = data.health;

        // Also fetch project tags
        try {
          const tagsRes = await fetch('/api/memories/tags');
          const tagsData = await tagsRes.json();
          projects = tagsData.projects || [];
        } catch {}

        renderHeader(data);
        renderProjects();
        renderTable(getVisibleMemories());

        if (data.search_mode === 'semantic' && currentFilter) {
          document.getElementById('searchMode').textContent = 'semantic search';
        } else if (currentFilter) {
          document.getElementById('searchMode').textContent = 'keyword search';
        } else {
          document.getElementById('searchMode').textContent = '';
        }
      } catch (err) {
        document.getElementById('tableWrap').innerHTML = '<p style="color:#f85149;padding:24px;">Failed: ' + err.message + '</p>';
      }
    }

    function getVisibleMemories() {
      if (!activeProject) return allMemories;
      return allMemories.filter(m => m.project === activeProject);
    }

    function filterByProject(name) {
      if (activeProject === name) {
        activeProject = null; // toggle off
      } else {
        activeProject = name;
      }
      renderProjects();
      renderTable(getVisibleMemories());
    }

    function renderProjects() {
      if (projects.length === 0) { document.getElementById('projectBar').innerHTML = ''; return; }
      let h = '<span style="color:#8b949e;font-size:12px;">Projects:</span> ';
      for (const p of projects) {
        const cls = activeProject === p.name ? 'project-chip active' : 'project-chip';
        h += '<span class="' + cls + '" onclick="filterByProject(\\'' + esc(p.name).replace(/'/g, "\\\\'") + '\\')">' + esc(p.name) + '<span class="count">' + p.count + '</span></span>';
      }
      document.getElementById('projectBar').innerHTML = h;
    }

    function renderHeader(data) {
      const h = data.health;
      const sc = h.score >= 8 ? 'score-good' : h.score >= 5 ? 'score-warn' : 'score-bad';
      let out = '<div style="display:flex;gap:24px;align-items:flex-start;margin-bottom:16px;">';
      out += '<div class="score-card"><div class="score-num ' + sc + '">' + h.score + '/10</div><div class="score-label">Health</div></div>';
      out += '<div class="stats">';
      out += stat(h.stats.total_memories, 'Total');
      out += stat(h.stats.db_memories, 'Database');
      out += stat(h.stats.file_entries, 'Files');
      out += stat(h.stats.stale_count, 'Stale');
      out += stat(h.stats.duplicate_groups, 'Duplicates');
      out += stat(h.stats.sources_detected, 'Platforms');
      out += '</div></div>';
      document.getElementById('header').innerHTML = out;
    }

    function renderTable(memories) {
      let h = '<table><tr>';
      h += '<th style="width:36px"><input type="checkbox" onchange="toggleAll(this.checked)" id="checkAll" /></th>';
      h += '<th>Project</th><th>Source</th><th>Content</th><th>Freshness</th><th>Flags</th>';
      h += '</tr>';

      for (const m of memories) {
        const fc = m.freshness_score >= 0.7 ? 'tag-fresh' : m.freshness_score >= 0.3 ? 'tag-aging' : 'tag-stale';
        const fl = m.freshness_score >= 0.7 ? 'fresh' : m.freshness_score >= 0.3 ? 'aging' : 'stale';
        const dup = m.duplicate_group ? '<span class="tag-dup">dup</span> ' : '';
        const sim = m.similarity ? '<span class="similarity">' + Math.round(m.similarity * 100) + '%</span> ' : '';
        const preview = esc(m.content.slice(0, 150));
        const isChecked = selected.has(m.id);
        const rowCls = isChecked ? 'selected' : '';
        const dis = m.deletable ? '' : 'disabled';
        const proj = m.project ? '<span class="tag-project" onclick="event.stopPropagation();filterByProject(\\'' + esc(m.project).replace(/'/g, "\\\\'") + '\\')">' + esc(m.project) + '</span>' : '<span style="color:#484f58">—</span>';

        h += '<tr class="' + rowCls + '" onclick="rowClick(event, \\'' + m.id + '\\', ' + m.deletable + ')">';
        h += '<td><input type="checkbox" ' + (isChecked ? 'checked' : '') + ' ' + dis + ' onchange="toggle(\\'' + m.id + '\\', this.checked, ' + m.deletable + ')" /></td>';
        h += '<td>' + proj + '</td>';
        h += '<td><span class="tag-source">' + m.source + '</span></td>';
        h += '<td class="content-cell" title="' + esc(m.content) + '">' + preview + '</td>';
        h += '<td class="' + fc + '">' + fl + '</td>';
        h += '<td>' + sim + dup + '</td>';
        h += '</tr>';
      }

      if (memories.length === 0) {
        h += '<tr><td colspan="6" class="empty">No memories match "' + esc(currentFilter) + '"</td></tr>';
      }
      h += '</table>';

      document.getElementById('tableWrap').innerHTML = h;
      updateSelectionBar();
    }

    function stat(n, label) {
      return '<div class="stat"><div class="stat-num">' + n + '</div><div class="stat-label">' + label + '</div></div>';
    }

    function esc(s) {
      if (!s) return '';
      return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
    }

    function parseTags(tagsStr) {
      try {
        const tags = JSON.parse(tagsStr);
        if (!Array.isArray(tags) || tags.length === 0) return '';
        return tags.map(t => '<span class="tag-tag">' + esc(t) + '</span>').join(' ');
      } catch { return ''; }
    }

    function toggle(id, checked, deletable) {
      if (!deletable) return;
      if (checked) selected.add(id);
      else selected.delete(id);
      renderTable(getVisibleMemories());
    }

    function rowClick(event, id, deletable) {
      if (event.target.tagName === 'INPUT' || event.target.tagName === 'SPAN') return;
      if (!deletable) return;
      if (selected.has(id)) selected.delete(id);
      else selected.add(id);
      renderTable(getVisibleMemories());
    }

    function toggleAll(checked) {
      const visible = getVisibleMemories();
      for (const m of visible) {
        if (!m.deletable) continue;
        if (checked) selected.add(m.id);
        else selected.delete(m.id);
      }
      renderTable(visible);
    }

    function clearSelection() {
      selected.clear();
      renderTable(getVisibleMemories());
    }

    function updateSelectionBar() {
      const bar = document.getElementById('selBar');
      const count = document.getElementById('selCount');
      if (selected.size > 0) {
        bar.classList.add('active');
        count.textContent = selected.size + ' selected';
      } else {
        bar.classList.remove('active');
      }
    }

    async function deleteSelected() {
      if (selected.size === 0) return;
      if (!confirm('Delete ' + selected.size + ' memories? This cannot be undone.')) return;

      try {
        const res = await fetch('/api/memories/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: [...selected] }),
        });
        const data = await res.json();
        selected.clear();
        toast(data.deleted + ' memories deleted');
        fetchAndRender();
      } catch (err) {
        toast('Delete failed: ' + err.message, true);
      }
    }

    function selectAllVisible() {
      selected.clear();
      const visible = getVisibleMemories();
      for (const m of visible) {
        if (m.deletable) selected.add(m.id);
      }
      renderTable(visible);
      toast(selected.size + ' memories selected');
    }

    function toast(msg, isError) {
      const el = document.getElementById('toast');
      el.textContent = msg;
      el.className = 'toast' + (isError ? ' error' : '');
      el.style.display = 'block';
      setTimeout(() => { el.style.display = 'none'; }, 3000);
    }

    fetchAndRender();
  </script>
</body>
</html>`;
}
