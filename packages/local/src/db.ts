import { v4 as uuid } from "uuid";
import { join } from "path";
import { mkdirSync, existsSync } from "fs";
import { homedir } from "os";
import type { MemoryRow } from "./types.js";

// Dynamic require to load node:sqlite — avoids Vite/bundler resolution issues
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { DatabaseSync } = require("node:sqlite");

const DB_DIR = join(homedir(), ".central-intelligence");
const DB_PATH = join(DB_DIR, "memories.db");

let db: any;

export function getDb(): any {
  if (db) return db;

  if (!existsSync(DB_DIR)) {
    mkdirSync(DB_DIR, { recursive: true });
  }

  db = new DatabaseSync(DB_PATH);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");

  // Create tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      user_id TEXT,
      scope TEXT NOT NULL DEFAULT 'agent',
      content TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '[]',
      embedding BLOB,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      deleted_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_memories_agent ON memories(agent_id);
    CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope);
    CREATE INDEX IF NOT EXISTS idx_memories_deleted ON memories(deleted_at);
  `);

  // File source cache — tracks content hashes and embeddings for parsed config files
  db.exec(`
    CREATE TABLE IF NOT EXISTS file_source_cache (
      content_hash TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      source_path TEXT NOT NULL,
      section_title TEXT,
      content TEXT NOT NULL,
      embedding BLOB,
      first_seen TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_fsc_source ON file_source_cache(source);
  `);

  // FTS5 virtual table for full-text search
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      content,
      content_rowid='rowid',
      tokenize='porter unicode61'
    );
  `);

  // Trigger to keep FTS in sync
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, content) VALUES (NEW.rowid, NEW.content);
    END;
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', OLD.rowid, OLD.content);
    END;
  `);

  return db;
}

export function store(
  agentId: string,
  content: string,
  embedding: number[],
  options: { userId?: string; scope?: string; tags?: string[] } = {}
): MemoryRow {
  const db = getDb();
  const id = uuid();
  const tags = JSON.stringify(options.tags || []);
  const scope = options.scope || "agent";
  const embeddingBuf = Buffer.from(new Float32Array(embedding).buffer);

  const stmt = db.prepare(`
    INSERT INTO memories (id, agent_id, user_id, scope, content, tags, embedding)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(id, agentId, options.userId || null, scope, content, tags, embeddingBuf);

  return db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as MemoryRow;
}

export function getAll(
  agentId: string,
  options: { scope?: string; includeShared?: boolean } = {}
): MemoryRow[] {
  const db = getDb();

  if (options.includeShared) {
    return db.prepare(`
      SELECT * FROM memories
      WHERE deleted_at IS NULL
        AND (agent_id = ? OR scope IN ('user', 'org'))
      ORDER BY created_at DESC
      LIMIT 500
    `).all(agentId) as MemoryRow[];
  }

  return db.prepare(`
    SELECT * FROM memories
    WHERE agent_id = ? AND deleted_at IS NULL
    ORDER BY created_at DESC
    LIMIT 500
  `).all(agentId) as MemoryRow[];
}

export function ftsSearch(query: string, limit: number = 50): { id: string; rank: number }[] {
  const db = getDb();
  try {
    const results = db.prepare(`
      SELECT m.id, rank
      FROM memories_fts fts
      JOIN memories m ON m.rowid = fts.rowid
      WHERE memories_fts MATCH ? AND m.deleted_at IS NULL
      ORDER BY rank
      LIMIT ?
    `).all(query, limit) as Array<{ id: string; rank: number }>;

    return results.map((r, i) => ({ id: r.id, rank: i + 1 }));
  } catch {
    return [];
  }
}

export function softDelete(memoryId: string): boolean {
  const db = getDb();
  const result = db.prepare(`
    UPDATE memories SET deleted_at = datetime('now')
    WHERE id = ? AND deleted_at IS NULL
  `).run(memoryId);
  return result.changes > 0;
}

export function updateScope(memoryId: string, targetScope: string, userId?: string): boolean {
  const db = getDb();
  const result = db.prepare(`
    UPDATE memories
    SET scope = ?, user_id = COALESCE(?, user_id)
    WHERE id = ? AND deleted_at IS NULL
  `).run(targetScope, userId || null, memoryId);
  return result.changes > 0;
}

export function getMemoryCount(): number {
  const db = getDb();
  const row = db.prepare("SELECT COUNT(*) as count FROM memories WHERE deleted_at IS NULL").get() as { count: number };
  return row.count;
}

export function getById(memoryId: string): MemoryRow | null {
  const db = getDb();
  return (db.prepare("SELECT * FROM memories WHERE id = ?").get(memoryId) as MemoryRow) || null;
}

// --- File source cache ---

export interface CachedFileEntry {
  content_hash: string;
  source: string;
  source_path: string;
  section_title: string | null;
  content: string;
  embedding: Uint8Array | null;
  first_seen: string;
  last_seen: string;
}

export function getCachedEntry(contentHash: string): CachedFileEntry | null {
  const db = getDb();
  return (db.prepare("SELECT * FROM file_source_cache WHERE content_hash = ?").get(contentHash) as CachedFileEntry) || null;
}

export function upsertCacheEntry(entry: {
  content_hash: string;
  source: string;
  source_path: string;
  section_title: string | null;
  content: string;
  embedding: Uint8Array | null;
}): void {
  const db = getDb();
  const existing = getCachedEntry(entry.content_hash);

  if (existing) {
    db.prepare(
      "UPDATE file_source_cache SET last_seen = datetime('now'), source_path = ?, section_title = ? WHERE content_hash = ?"
    ).run(entry.source_path, entry.section_title, entry.content_hash);
  } else {
    db.prepare(
      `INSERT INTO file_source_cache (content_hash, source, source_path, section_title, content, embedding)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(entry.content_hash, entry.source, entry.source_path, entry.section_title, entry.content, entry.embedding);
  }
}

export function getAllCachedEntries(): CachedFileEntry[] {
  const db = getDb();
  return db.prepare("SELECT * FROM file_source_cache ORDER BY last_seen DESC").all() as CachedFileEntry[];
}

// Re-export getAllMemories for ci-local-pro compatibility
export function getAllMemories(): MemoryRow[] {
  const db = getDb();
  return db.prepare("SELECT * FROM memories WHERE deleted_at IS NULL ORDER BY created_at DESC").all() as MemoryRow[];
}
