import Database from "better-sqlite3";
import { v4 as uuid } from "uuid";
import { join } from "path";
import { mkdirSync, existsSync } from "fs";
import { homedir } from "os";
import type { MemoryRow } from "./types.js";

const DB_DIR = join(homedir(), ".central-intelligence");
const DB_PATH = join(DB_DIR, "memories.db");

let db: Database.Database;

export function getDb(): Database.Database {
  if (db) return db;

  if (!existsSync(DB_DIR)) {
    mkdirSync(DB_DIR, { recursive: true });
  }

  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

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

export function getById(memoryId: string): MemoryRow | null {
  const db = getDb();
  return (db.prepare("SELECT * FROM memories WHERE id = ?").get(memoryId) as MemoryRow) || null;
}
