import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  parseMarkdownSections,
  parseParagraphs,
  discoverFiles,
  parseAllFiles,
  contentHash,
} from "../src/file-sources.js";

// --- Content hash ---

describe("contentHash", () => {
  it("returns a 16-char hex string", () => {
    const hash = contentHash("hello world");
    expect(hash).toHaveLength(16);
    expect(hash).toMatch(/^[0-9a-f]+$/);
  });

  it("returns the same hash for identical content", () => {
    expect(contentHash("test")).toBe(contentHash("test"));
  });

  it("returns different hashes for different content", () => {
    expect(contentHash("a")).not.toBe(contentHash("b"));
  });
});

// --- Markdown parser ---

describe("parseMarkdownSections", () => {
  it("splits on ## headings", () => {
    const content = `## Section One
Content of section one.

## Section Two
Content of section two.`;

    const entries = parseMarkdownSections(content, "/test/CLAUDE.md", "claude_md");
    expect(entries).toHaveLength(2);
    expect(entries[0].section_title).toBe("Section One");
    expect(entries[0].content).toContain("Content of section one");
    expect(entries[0].source).toBe("claude_md");
    expect(entries[1].section_title).toBe("Section Two");
  });

  it("falls back to # headings when no ## found", () => {
    const content = `# Top Level
Some content.

# Another Top
More content.`;

    const entries = parseMarkdownSections(content, "/test/CLAUDE.md", "claude_md");
    expect(entries).toHaveLength(2);
    expect(entries[0].section_title).toBe("Top Level");
    expect(entries[1].section_title).toBe("Another Top");
  });

  it("treats entire file as one entry when no headings", () => {
    const content = `Just some plain text without any headings.
Multiple lines of content.`;

    const entries = parseMarkdownSections(content, "/test/CLAUDE.md", "claude_md");
    expect(entries).toHaveLength(1);
    expect(entries[0].section_title).toBeNull();
    expect(entries[0].content).toContain("Just some plain text");
  });

  it("returns empty array for empty content", () => {
    expect(parseMarkdownSections("", "/test/f.md", "claude_md")).toHaveLength(0);
    expect(parseMarkdownSections("   \n  ", "/test/f.md", "claude_md")).toHaveLength(0);
  });

  it("handles mixed ## and ### correctly (only splits on ##)", () => {
    const content = `## Main Section
Intro text.

### Subsection
Sub content.

## Another Section
Another content.`;

    const entries = parseMarkdownSections(content, "/test/f.md", "claude_md");
    expect(entries).toHaveLength(2);
    expect(entries[0].section_title).toBe("Main Section");
    expect(entries[0].content).toContain("### Subsection");
    expect(entries[1].section_title).toBe("Another Section");
  });

  it("preserves content before first heading as a section", () => {
    const content = `Preamble text before any heading.

## First Section
Section content.`;

    const entries = parseMarkdownSections(content, "/test/f.md", "claude_md");
    expect(entries).toHaveLength(2);
    expect(entries[0].section_title).toBeNull();
    expect(entries[0].content).toContain("Preamble text");
    expect(entries[1].section_title).toBe("First Section");
  });

  it("each entry has a unique content_hash", () => {
    const content = `## A
Alpha content.

## B
Beta content.`;

    const entries = parseMarkdownSections(content, "/test/f.md", "claude_md");
    expect(entries[0].content_hash).not.toBe(entries[1].content_hash);
  });
});

// --- Paragraph parser ---

describe("parseParagraphs", () => {
  it("splits on double newlines", () => {
    const content = `First rule: always use TypeScript.

Second rule: prefer functional style.

Third rule: no classes.`;

    const entries = parseParagraphs(content, "/test/.cursor/rules", "cursor_rules");
    expect(entries).toHaveLength(3);
    expect(entries[0].content).toContain("First rule");
    expect(entries[0].source).toBe("cursor_rules");
    expect(entries[1].section_title).toBe("paragraph-2");
  });

  it("returns single entry for single paragraph", () => {
    const content = "One rule only: be consistent.";
    const entries = parseParagraphs(content, "/test/rules", "cursor_rules");
    expect(entries).toHaveLength(1);
    expect(entries[0].section_title).toBeNull();
  });

  it("returns empty for empty/whitespace content", () => {
    expect(parseParagraphs("", "/test/r", "cursor_rules")).toHaveLength(0);
    expect(parseParagraphs("  \n\n  ", "/test/r", "cursor_rules")).toHaveLength(0);
  });

  it("handles extra blank lines between paragraphs", () => {
    const content = `First paragraph.



Second paragraph.`;

    const entries = parseParagraphs(content, "/test/r", "windsurf_rules");
    expect(entries).toHaveLength(2);
  });
});

// --- File discovery ---

describe("discoverFiles", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `ci-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("discovers CLAUDE.md in CWD", () => {
    writeFileSync(join(tmpDir, "CLAUDE.md"), "## Test\nContent");
    const files = discoverFiles(tmpDir);
    const claudeFiles = files.filter((f) => f.source === "claude_md" && f.path.startsWith(tmpDir));
    expect(claudeFiles).toHaveLength(1);
    expect(claudeFiles[0].path).toBe(join(tmpDir, "CLAUDE.md"));
  });

  it("discovers .cursor/rules", () => {
    mkdirSync(join(tmpDir, ".cursor"), { recursive: true });
    writeFileSync(join(tmpDir, ".cursor/rules"), "Use TypeScript.");
    const files = discoverFiles(tmpDir);
    const cursorFiles = files.filter((f) => f.source === "cursor_rules");
    expect(cursorFiles).toHaveLength(1);
    expect(cursorFiles[0].source).toBe("cursor_rules");
  });

  it("discovers multiple platforms", () => {
    writeFileSync(join(tmpDir, "CLAUDE.md"), "## Test\nContent");
    mkdirSync(join(tmpDir, ".cursor"), { recursive: true });
    writeFileSync(join(tmpDir, ".cursor/rules"), "Rules here.");
    mkdirSync(join(tmpDir, ".github"), { recursive: true });
    writeFileSync(join(tmpDir, ".github/copilot-instructions.md"), "## Instructions\nDo this.");

    const files = discoverFiles(tmpDir);
    const cwdFiles = files.filter((f) => f.path.startsWith(tmpDir));
    expect(cwdFiles).toHaveLength(3);
    const sources = cwdFiles.map((f) => f.source);
    expect(sources).toContain("claude_md");
    expect(sources).toContain("cursor_rules");
    expect(sources).toContain("copilot_instructions");
  });

  it("returns no CWD config files for directory with none", () => {
    const files = discoverFiles(tmpDir);
    // May still find ~/.claude/CLAUDE.md from the real home dir
    const cwdFiles = files.filter((f) => f.path.startsWith(tmpDir));
    expect(cwdFiles).toHaveLength(0);
  });

  it("prefers CLAUDE.md over .claude/CLAUDE.md", () => {
    writeFileSync(join(tmpDir, "CLAUDE.md"), "Root version");
    mkdirSync(join(tmpDir, ".claude"), { recursive: true });
    writeFileSync(join(tmpDir, ".claude/CLAUDE.md"), "Nested version");

    const files = discoverFiles(tmpDir);
    const claude = files.find((f) => f.source === "claude_md");
    expect(claude).toBeDefined();
    expect(claude!.path).toBe(join(tmpDir, "CLAUDE.md")); // First match wins
  });
});

// --- parseAllFiles integration ---

describe("parseAllFiles", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `ci-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("parses CLAUDE.md + .cursor/rules into entries", () => {
    writeFileSync(
      join(tmpDir, "CLAUDE.md"),
      "## Architecture\nUse Hono.\n\n## Testing\nUse Vitest."
    );
    mkdirSync(join(tmpDir, ".cursor"), { recursive: true });
    writeFileSync(join(tmpDir, ".cursor/rules"), "Always use TypeScript.\n\nPrefer const.");

    const { entries, files, warnings } = parseAllFiles(tmpDir);
    const cwdFiles = files.filter((f) => f.path.startsWith(tmpDir));
    const cwdEntries = entries.filter((e) => e.source_path.startsWith(tmpDir));
    expect(cwdFiles).toHaveLength(2);
    expect(cwdEntries).toHaveLength(4);
    expect(warnings).toHaveLength(0);

    const claudeEntries = cwdEntries.filter((e) => e.source === "claude_md");
    const cursorEntries = cwdEntries.filter((e) => e.source === "cursor_rules");
    expect(claudeEntries).toHaveLength(2);
    expect(cursorEntries).toHaveLength(2);
  });

  it("skips empty files without warnings", () => {
    writeFileSync(join(tmpDir, "CLAUDE.md"), "");
    const { entries, warnings } = parseAllFiles(tmpDir);
    const cwdEntries = entries.filter((e) => e.source_path.startsWith(tmpDir));
    expect(cwdEntries).toHaveLength(0);
    expect(warnings).toHaveLength(0);
  });

  it("returns no CWD entries when no CWD config files exist", () => {
    const { entries, files } = parseAllFiles(tmpDir);
    // May still find ~/.claude/CLAUDE.md from the real home dir
    const cwdFiles = files.filter((f) => f.path.startsWith(tmpDir));
    const cwdEntries = entries.filter((e) => e.source_path.startsWith(tmpDir));
    expect(cwdFiles).toHaveLength(0);
    expect(cwdEntries).toHaveLength(0);
  });
});
