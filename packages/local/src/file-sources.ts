import { readFileSync, existsSync, statSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { createHash } from "crypto";

export interface FileSourceEntry {
  content_hash: string;
  source: "claude_md" | "claude_memory" | "cursor_rules" | "windsurf_rules" | "codex_config" | "copilot_instructions" | "chatgpt_instructions";
  source_path: string;
  section_title: string | null;
  content: string;
}

interface PlatformConfig {
  source: FileSourceEntry["source"];
  paths: string[];
  parser: (content: string, path: string) => FileSourceEntry[];
}

export function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

// --- Parsers ---

/**
 * Split markdown on ## headings. Falls back to # if no ## found.
 * Entire file as one entry if no headings at all.
 */
export function parseMarkdownSections(
  content: string,
  path: string,
  source: FileSourceEntry["source"]
): FileSourceEntry[] {
  if (!content.trim()) return [];

  let sections = splitOnHeadings(content, "## ");
  if (sections.length <= 1) {
    sections = splitOnHeadings(content, "# ");
  }

  if (sections.length <= 1) {
    const trimmed = content.trim();
    if (!trimmed) return [];
    return [{
      content_hash: contentHash(trimmed),
      source,
      source_path: path,
      section_title: null,
      content: trimmed,
    }];
  }

  return sections
    .filter((s) => s.content.trim())
    .map((s) => ({
      content_hash: contentHash(s.content.trim()),
      source,
      source_path: path,
      section_title: s.title,
      content: s.content.trim(),
    }));
}

function splitOnHeadings(
  content: string,
  prefix: string
): { title: string | null; content: string }[] {
  const lines = content.split("\n");
  const sections: { title: string | null; content: string }[] = [];
  let currentTitle: string | null = null;
  let currentLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith(prefix) && !line.startsWith(prefix + "#")) {
      if (currentLines.length > 0 || currentTitle !== null) {
        sections.push({ title: currentTitle, content: currentLines.join("\n") });
      }
      currentTitle = line.slice(prefix.length).trim();
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }

  if (currentLines.length > 0 || currentTitle !== null) {
    sections.push({ title: currentTitle, content: currentLines.join("\n") });
  }

  return sections;
}

/**
 * Split on double-newlines (paragraphs). For Cursor/Windsurf rules.
 */
export function parseParagraphs(
  content: string,
  path: string,
  source: FileSourceEntry["source"]
): FileSourceEntry[] {
  if (!content.trim()) return [];

  const paragraphs = content
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  if (paragraphs.length === 0) return [];

  return paragraphs.map((p, i) => ({
    content_hash: contentHash(p),
    source,
    source_path: path,
    section_title: paragraphs.length === 1 ? null : `paragraph-${i + 1}`,
    content: p,
  }));
}

// --- Platform configs ---

const PLATFORMS: PlatformConfig[] = [
  {
    source: "claude_md",
    paths: [
      "CLAUDE.md",
      ".claude/CLAUDE.md",
      join(homedir(), ".claude", "CLAUDE.md"),
    ],
    parser: (content, path) => parseMarkdownSections(content, path, "claude_md"),
  },
  {
    source: "cursor_rules",
    paths: [".cursor/rules", ".cursorrules"],
    parser: (content, path) => parseParagraphs(content, path, "cursor_rules"),
  },
  {
    source: "windsurf_rules",
    paths: [".windsurf/rules"],
    parser: (content, path) => parseParagraphs(content, path, "windsurf_rules"),
  },
  {
    source: "codex_config",
    paths: ["codex.md", ".codex/config"],
    parser: (content, path) => parseMarkdownSections(content, path, "codex_config"),
  },
  {
    source: "copilot_instructions",
    paths: [".github/copilot-instructions.md"],
    parser: (content, path) => parseMarkdownSections(content, path, "copilot_instructions"),
  },
  {
    source: "chatgpt_instructions",
    paths: [".chatgpt/instructions.md", ".chatgpt/custom-instructions.md"],
    parser: (content, path) => parseMarkdownSections(content, path, "chatgpt_instructions"),
  },
  // Claude Code MEMORY.md — individual memory files in project memory dirs
  // These are the richest source of existing context on any developer's machine
  {
    source: "claude_memory",
    paths: [], // Handled by special scanner in discoverFiles
    parser: (content, path) => parseMarkdownSections(content, path, "claude_memory"),
  },
];

// --- Discovery ---

export interface DiscoveredFile {
  source: FileSourceEntry["source"];
  path: string;
  size: number;
}

export function discoverFiles(cwd: string = process.cwd()): DiscoveredFile[] {
  const found: DiscoveredFile[] = [];

  for (const platform of PLATFORMS) {
    if (platform.source === "claude_memory") continue; // Handled below

    for (const relPath of platform.paths) {
      const absPath = relPath.startsWith("/") ? relPath : join(cwd, relPath);

      if (existsSync(absPath)) {
        try {
          const stat = statSync(absPath);
          if (stat.isFile()) {
            found.push({ source: platform.source, path: absPath, size: stat.size });
            break; // First match per platform
          }
        } catch {
          // Permission denied, skip
        }
      }
    }
  }

  // Scan Claude Code memory directories
  // Individual memory files (*.md, not MEMORY.md index) contain the actual memories
  const claudeMemoryDirs = [
    join(homedir(), ".claude", "projects"),
  ];

  for (const memDir of claudeMemoryDirs) {
    if (!existsSync(memDir)) continue;
    try {
      const { readdirSync } = require("fs");
      const projects = readdirSync(memDir) as string[];
      for (const project of projects) {
        const memoryDir = join(memDir, project, "memory");
        if (!existsSync(memoryDir)) continue;
        try {
          const files = readdirSync(memoryDir) as string[];
          for (const file of files) {
            if (!file.endsWith(".md") || file === "MEMORY.md") continue;
            const absPath = join(memoryDir, file);
            try {
              const stat = statSync(absPath);
              if (stat.isFile() && stat.size > 0) {
                found.push({ source: "claude_memory", path: absPath, size: stat.size });
              }
            } catch {}
          }
        } catch {}
      }
    } catch {}
  }

  return found;
}

/**
 * Parse all discovered files into memory entries.
 */
export function parseAllFiles(cwd: string = process.cwd()): {
  entries: FileSourceEntry[];
  files: DiscoveredFile[];
  warnings: string[];
} {
  const files = discoverFiles(cwd);
  const entries: FileSourceEntry[] = [];
  const warnings: string[] = [];

  for (const file of files) {
    if (file.size > 100 * 1024) {
      warnings.push(`${file.path}: unusually large (${Math.round(file.size / 1024)}KB)`);
    }

    try {
      const content = readFileSync(file.path, "utf-8");
      const platform = PLATFORMS.find((p) => p.source === file.source);
      if (platform) {
        entries.push(...platform.parser(content, file.path));
      }
    } catch (err: any) {
      if (err.code === "ERR_INVALID_ARG_VALUE" || err.message?.includes("encoding")) {
        warnings.push(`${file.path}: not UTF-8 encoded, skipping`);
      } else {
        warnings.push(`${file.path}: ${err.message}`);
      }
    }
  }

  return { entries, files, warnings };
}
