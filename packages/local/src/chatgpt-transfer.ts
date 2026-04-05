import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { createHash } from "crypto";

const EXPORT_DIR = join(homedir(), ".central-intelligence", "chatgpt-export");
const CONVERSATIONS_PATH = join(EXPORT_DIR, "conversations.json");

interface ParsedMemory {
  content: string;
  conversation_title: string;
  timestamp: string;
  content_hash: string;
}

// === Paste-based transfer (preferred — fully private) ===

/**
 * Parse pasted ChatGPT conversation text and extract instructional memories.
 *
 * ChatGPT copy-paste output typically looks like:
 *
 *   You said:
 *   [user message text]
 *
 *   ChatGPT said:
 *   [assistant response text]
 *
 * Or in some formats:
 *   User: [text]
 *   Assistant: [text]
 *
 * We extract only user messages that contain instructional content.
 */
export async function transferFromPaste(options: {
  text: string;
  conversationName: string;
  limit: number;
  storeFn: (content: string, tags: string[]) => Promise<any>;
}): Promise<{
  imported: number;
  skipped: number;
  total_messages: number;
  extracted: number;
  conversation: string;
}> {
  const userMessages = parseConversationText(options.text);

  // Filter for instructional memories
  const memories: ParsedMemory[] = [];
  for (const msg of userMessages) {
    const memory = extractMemory(msg, options.conversationName);
    if (memory) memories.push(memory);
  }

  // Deduplicate
  const seen = new Set<string>();
  const unique = memories.filter((m) => {
    if (seen.has(m.content_hash)) return false;
    seen.add(m.content_hash);
    return true;
  });

  // Apply limit
  const toImport = unique.slice(0, options.limit);

  let imported = 0;
  let skipped = 0;

  for (const m of toImport) {
    try {
      await options.storeFn(m.content, [
        "chatgpt-transfer",
        `chat:${options.conversationName.slice(0, 50)}`,
      ]);
      imported++;
    } catch {
      skipped++;
    }
  }

  return {
    imported,
    skipped,
    total_messages: userMessages.length,
    extracted: unique.length,
    conversation: options.conversationName,
  };
}

/**
 * Parse conversation text into user messages.
 * Handles multiple ChatGPT copy-paste formats.
 */
function parseConversationText(text: string): string[] {
  const messages: string[] = [];

  // Format 1: "You said:" / "ChatGPT said:" (most common from web copy)
  if (text.includes("You said:") || text.includes("You said:\n")) {
    const blocks = text.split(/(?=You said:)/i);
    for (const block of blocks) {
      if (!block.match(/^You said:/i)) continue;
      // Extract text between "You said:" and "ChatGPT said:" (or end)
      const content = block
        .replace(/^You said:\s*/i, "")
        .replace(/ChatGPT said:[\s\S]*$/i, "")
        .trim();
      if (content) messages.push(content);
    }
    if (messages.length > 0) return messages;
  }

  // Format 2: "User:" / "Assistant:" style
  if (text.includes("User:") || text.includes("Human:")) {
    const userPattern = /(?:^|\n)(?:User|Human):\s*([\s\S]*?)(?=\n(?:Assistant|AI|ChatGPT):|\n(?:User|Human):|\s*$)/gi;
    let match;
    while ((match = userPattern.exec(text)) !== null) {
      const content = match[1].trim();
      if (content) messages.push(content);
    }
    if (messages.length > 0) return messages;
  }

  // Format 3: Alternating blocks separated by blank lines
  // Assume odd blocks (1st, 3rd, 5th...) are user messages
  const blocks = text
    .split(/\n{3,}/)
    .map((b) => b.trim())
    .filter((b) => b.length > 0);

  if (blocks.length >= 2) {
    for (let i = 0; i < blocks.length; i += 2) {
      messages.push(blocks[i]);
    }
    if (messages.length > 0) return messages;
  }

  // Format 4: Can't determine structure — treat the whole thing as one block
  // and try to extract instructional sentences
  const sentences = text
    .split(/(?<=[.!?\n])\s+/)
    .filter((s) => s.trim().length > 20);

  if (sentences.length > 0) {
    // Group consecutive instructional sentences into chunks
    let currentChunk: string[] = [];
    for (const sentence of sentences) {
      const isInstructional =
        /\b(always|never|prefer|use|don't|avoid|make sure|remember|important)\b/i.test(sentence) ||
        /\b(i want|i need|i like|my preference|my style)\b/i.test(sentence) ||
        /\b(the project|the codebase|the stack|our team|we use)\b/i.test(sentence);

      if (isInstructional) {
        currentChunk.push(sentence.trim());
      } else if (currentChunk.length > 0) {
        messages.push(currentChunk.join(" "));
        currentChunk = [];
      }
    }
    if (currentChunk.length > 0) {
      messages.push(currentChunk.join(" "));
    }
  }

  return messages;
}

// === Helpers ===

function extractMemory(text: string, title: string, createTime?: number): ParsedMemory | null {
  if (!text || text.length < 30 || text.length > 2000) return null;

  // Skip questions
  const questionMarks = (text.match(/\?/g) || []).length;
  const sentences = text.split(/[.!?\n]/).filter((s) => s.trim().length > 0).length;
  if (sentences > 0 && questionMarks / sentences > 0.5) return null;

  const isInstructional =
    /\b(always|never|prefer|use|don't|avoid|make sure|remember|important)\b/i.test(text) ||
    /\b(i want|i need|i like|my preference|my style)\b/i.test(text) ||
    /\b(the project|the codebase|the stack|our team|we use)\b/i.test(text);
  if (!isInstructional) return null;

  return {
    content: text,
    conversation_title: title,
    timestamp: createTime
      ? new Date(createTime * 1000).toISOString()
      : new Date().toISOString(),
    content_hash: createHash("sha256").update(text).digest("hex").slice(0, 16),
  };
}

// === File-based approach (bulk, for users who exported) ===

export async function listChatGPTConversations(filter?: string): Promise<{
  conversations: { title: string; instructional_count: number; date: string; project?: string }[];
  projects: string[];
  total_memories: number;
  export_path: string;
  has_export: boolean;
}> {
  if (!existsSync(CONVERSATIONS_PATH)) {
    return { conversations: [], projects: [], total_memories: 0, export_path: CONVERSATIONS_PATH, has_export: false };
  }

  const conversations = JSON.parse(readFileSync(CONVERSATIONS_PATH, "utf-8"));
  const allMemories = extractMemoriesFromExport(conversations);

  const convMap = new Map<string, { title: string; instructional_count: number; date: string; project?: string }>();
  for (const conv of conversations) {
    const title = conv.title || "Untitled";
    const convId = conv.id || title;
    const project = conv.folder_name || conv.project_name || undefined;
    const count = allMemories.filter((m) => m.conversation_title === title).length;
    if (count === 0) continue;
    convMap.set(convId, {
      title,
      instructional_count: count,
      date: conv.create_time ? new Date(conv.create_time * 1000).toLocaleDateString() : "unknown",
      project,
    });
  }

  let convList = [...convMap.values()];
  if (filter) {
    const f = filter.toLowerCase();
    convList = convList.filter(
      (c) => c.title.toLowerCase().includes(f) || (c.project && c.project.toLowerCase().includes(f))
    );
  }
  convList.sort((a, b) => b.instructional_count - a.instructional_count);

  return {
    conversations: convList.slice(0, 20),
    projects: [...new Set(convList.map((c) => c.project).filter(Boolean))] as string[],
    total_memories: allMemories.length,
    export_path: CONVERSATIONS_PATH,
    has_export: true,
  };
}

export async function transferChatGPT(options: {
  conversationTitles?: string[];
  projectName?: string;
  limit: number;
  storeFn: (content: string, tags: string[]) => Promise<any>;
}): Promise<{ imported: number; skipped: number; conversations_matched: string[] }> {
  const conversations = JSON.parse(readFileSync(CONVERSATIONS_PATH, "utf-8"));
  const allMemories = extractMemoriesFromExport(conversations);

  let selected: ParsedMemory[];
  if (options.projectName) {
    const pn = options.projectName.toLowerCase();
    selected = allMemories.filter((m) => {
      const conv = conversations.find((c: any) => (c.title || "Untitled") === m.conversation_title);
      const project = conv?.folder_name || conv?.project_name || "";
      return project.toLowerCase().includes(pn);
    });
  } else if (options.conversationTitles?.length) {
    const titles = new Set(options.conversationTitles.map((t) => t.toLowerCase()));
    selected = allMemories.filter((m) => titles.has(m.conversation_title.toLowerCase()));
  } else {
    selected = allMemories;
  }

  selected.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  const toImport = selected.slice(0, options.limit);
  const matchedConvs = [...new Set(toImport.map((m) => m.conversation_title))];

  let imported = 0, skipped = 0;
  for (const m of toImport) {
    try {
      await options.storeFn(m.content, ["chatgpt-transfer", `chat:${m.conversation_title.slice(0, 50)}`]);
      imported++;
    } catch { skipped++; }
  }

  return { imported, skipped, conversations_matched: matchedConvs };
}

function extractMemoriesFromExport(conversations: any[]): ParsedMemory[] {
  const memories: ParsedMemory[] = [];
  for (const conv of conversations) {
    const title = conv.title || "Untitled";
    const mapping = conv.mapping;
    if (!mapping) continue;
    for (const node of Object.values(mapping) as any[]) {
      const msg = node?.message;
      if (!msg || msg.author?.role !== "user") continue;
      const parts = msg.content?.parts;
      if (!Array.isArray(parts)) continue;
      const text = parts.filter((p: any) => typeof p === "string").join("\n").trim();
      const memory = extractMemory(text, title, msg.create_time);
      if (memory) memories.push(memory);
    }
  }
  const seen = new Set<string>();
  return memories.filter((m) => { if (seen.has(m.content_hash)) return false; seen.add(m.content_hash); return true; });
}
