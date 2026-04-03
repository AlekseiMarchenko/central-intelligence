import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// We need to override the DB path before importing db.ts.
// Set HOME to a temp dir so ~/.central-intelligence/ is isolated.
const originalHome = process.env.HOME;
let tmpHome: string;

beforeEach(() => {
  tmpHome = join(tmpdir(), `ci-db-test-${Date.now()}`);
  process.env.HOME = tmpHome;
});

afterEach(() => {
  process.env.HOME = originalHome;
  try {
    rmSync(tmpHome, { recursive: true, force: true });
  } catch {}
  // Reset module cache so db.ts re-initializes with new HOME
  vi.resetModules();
});

describe("file_source_cache", () => {
  it("creates the file_source_cache table on init", async () => {
    const { getDb } = await import("../src/db.js");
    const db = getDb();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as { name: string }[];
    const tableNames = tables.map((t) => t.name);
    expect(tableNames).toContain("file_source_cache");
  });

  it("upserts and retrieves a cache entry", async () => {
    const { upsertCacheEntry, getCachedEntry } = await import("../src/db.js");

    upsertCacheEntry({
      content_hash: "abc123",
      source: "claude_md",
      source_path: "/test/CLAUDE.md",
      section_title: "Architecture",
      content: "Use Hono framework.",
      embedding: Buffer.from(new Float32Array([0.1, 0.2, 0.3]).buffer),
    });

    const cached = getCachedEntry("abc123");
    expect(cached).not.toBeNull();
    expect(cached!.source).toBe("claude_md");
    expect(cached!.content).toBe("Use Hono framework.");
    expect(cached!.section_title).toBe("Architecture");
    expect(cached!.embedding).not.toBeNull();
  });

  it("updates last_seen on re-upsert without changing first_seen", async () => {
    const { upsertCacheEntry, getCachedEntry, getDb } = await import("../src/db.js");

    // Insert with a known first_seen
    const db = getDb();
    db.prepare(
      `INSERT INTO file_source_cache (content_hash, source, source_path, section_title, content, embedding, first_seen, last_seen)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now', '-1 day'), datetime('now', '-1 day'))`
    ).run("hash1", "cursor_rules", "/test/.cursor/rules", null, "Old content", null);

    const before = getCachedEntry("hash1");
    expect(before).not.toBeNull();
    const firstSeen = before!.first_seen;

    // Re-upsert
    upsertCacheEntry({
      content_hash: "hash1",
      source: "cursor_rules",
      source_path: "/test/.cursor/rules",
      section_title: "Updated",
      content: "Old content",
      embedding: null,
    });

    const after = getCachedEntry("hash1");
    expect(after!.first_seen).toBe(firstSeen); // Unchanged
    expect(after!.section_title).toBe("Updated"); // Updated
  });

  it("getAllCachedEntries returns all entries", async () => {
    const { upsertCacheEntry, getAllCachedEntries } = await import("../src/db.js");

    upsertCacheEntry({
      content_hash: "h1",
      source: "claude_md",
      source_path: "/a",
      section_title: null,
      content: "Entry 1",
      embedding: null,
    });
    upsertCacheEntry({
      content_hash: "h2",
      source: "cursor_rules",
      source_path: "/b",
      section_title: null,
      content: "Entry 2",
      embedding: null,
    });

    const all = getAllCachedEntries();
    expect(all).toHaveLength(2);
  });

  it("getCachedEntry returns null for unknown hash", async () => {
    const { getCachedEntry } = await import("../src/db.js");
    expect(getCachedEntry("nonexistent")).toBeNull();
  });
});
