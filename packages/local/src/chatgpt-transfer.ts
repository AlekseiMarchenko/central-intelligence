import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { createHash } from "crypto";

const EXPORT_DIR = join(homedir(), ".central-intelligence", "chatgpt-export");
const CONVERSATIONS_PATH = join(EXPORT_DIR, "conversations.json");

interface ParsedMemory {
  content: string;
  conversation_title: string;
  conversation_id: string;
  timestamp: string;
  content_hash: string;
  project?: string;
}

interface ConversationInfo {
  title: string;
  id: string;
  message_count: number;
  instructional_count: number;
  date: string;
  project?: string;
}

// --- Parse the ChatGPT export ---

function loadConversations(): any[] {
  if (!existsSync(CONVERSATIONS_PATH)) {
    throw new Error(
      `ChatGPT export not found at ${CONVERSATIONS_PATH}\n\n` +
      `To set up:\n` +
      `1. Go to chat.openai.com → Settings → Data controls → Export data\n` +
      `2. Wait for email, download ZIP, unzip\n` +
      `3. Copy conversations.json to ~/.central-intelligence/chatgpt-export/\n\n` +
      `  mkdir -p ~/.central-intelligence/chatgpt-export\n` +
      `  cp ~/Downloads/conversations.json ~/.central-intelligence/chatgpt-export/`
    );
  }

  try {
    return JSON.parse(readFileSync(CONVERSATIONS_PATH, "utf-8"));
  } catch (err: any) {
    throw new Error(`Cannot parse conversations.json: ${err.message}`);
  }
}

function extractMemories(conversations: any[]): ParsedMemory[] {
  const memories: ParsedMemory[] = [];

  for (const conv of conversations) {
    const title = conv.title || "Untitled";
    const convId = conv.id || conv.conversation_id || title;
    const project = conv.folder_name || conv.project_name || undefined;
    const mapping = conv.mapping;
    if (!mapping || typeof mapping !== "object") continue;

    for (const node of Object.values(mapping) as any[]) {
      const msg = node?.message;
      if (!msg || msg.author?.role !== "user") continue;

      const parts = msg.content?.parts;
      if (!Array.isArray(parts)) continue;
      const text = parts.filter((p: any) => typeof p === "string").join("\n").trim();
      if (!text || text.length < 30 || text.length > 2000) continue;

      // Skip questions
      const questionMarks = (text.match(/\?/g) || []).length;
      const sentences = text.split(/[.!?\n]/).filter((s) => s.trim().length > 0).length;
      if (sentences > 0 && questionMarks / sentences > 0.5) continue;

      // Instructional filter
      const isInstructional =
        /\b(always|never|prefer|use|don't|avoid|make sure|remember|important)\b/i.test(text) ||
        /\b(i want|i need|i like|my preference|my style)\b/i.test(text) ||
        /\b(the project|the codebase|the stack|our team|we use)\b/i.test(text);
      if (!isInstructional) continue;

      const hash = createHash("sha256").update(text).digest("hex").slice(0, 16);
      const timestamp = msg.create_time
        ? new Date(msg.create_time * 1000).toISOString()
        : conv.create_time
        ? new Date(conv.create_time * 1000).toISOString()
        : new Date().toISOString();

      memories.push({ content: text, conversation_title: title, conversation_id: convId, timestamp, content_hash: hash, project });
    }
  }

  // Deduplicate
  const seen = new Set<string>();
  return memories.filter((m) => {
    if (seen.has(m.content_hash)) return false;
    seen.add(m.content_hash);
    return true;
  });
}

// --- List conversations ---

export async function listChatGPTConversations(filter?: string): Promise<{
  conversations: ConversationInfo[];
  projects: string[];
  total_memories: number;
  export_path: string;
}> {
  const conversations = loadConversations();
  const allMemories = extractMemories(conversations);

  // Build conversation summaries
  const convMap = new Map<string, ConversationInfo>();
  for (const conv of conversations) {
    const title = conv.title || "Untitled";
    const convId = conv.id || conv.conversation_id || title;
    const project = conv.folder_name || conv.project_name || undefined;
    const mapping = conv.mapping;
    if (!mapping) continue;

    let msgCount = 0;
    for (const node of Object.values(mapping) as any[]) {
      if (node?.message?.author?.role === "user") msgCount++;
    }

    const instructionalCount = allMemories.filter((m) => m.conversation_id === convId).length;
    if (instructionalCount === 0) continue;

    convMap.set(convId, {
      title,
      id: convId,
      message_count: msgCount,
      instructional_count: instructionalCount,
      date: conv.create_time ? new Date(conv.create_time * 1000).toLocaleDateString() : "unknown",
      project,
    });
  }

  let convList = [...convMap.values()];

  // Filter by search term
  if (filter) {
    const f = filter.toLowerCase();
    convList = convList.filter(
      (c) => c.title.toLowerCase().includes(f) || (c.project && c.project.toLowerCase().includes(f))
    );
  }

  // Sort by instructional content
  convList.sort((a, b) => b.instructional_count - a.instructional_count);

  const projects = [...new Set(convList.map((c) => c.project).filter(Boolean))] as string[];

  return {
    conversations: convList.slice(0, 20),
    projects,
    total_memories: allMemories.length,
    export_path: CONVERSATIONS_PATH,
  };
}

// --- Transfer (import) ---

export async function transferChatGPT(options: {
  conversationTitles?: string[];
  projectName?: string;
  limit: number;
  storeFn: (content: string, tags: string[], timestamp: string) => Promise<any>;
}): Promise<{
  imported: number;
  skipped: number;
  conversations_matched: string[];
}> {
  const conversations = loadConversations();
  const allMemories = extractMemories(conversations);

  // Filter to selected conversations/project
  let selected: ParsedMemory[];

  if (options.projectName) {
    const pn = options.projectName.toLowerCase();
    selected = allMemories.filter((m) => m.project && m.project.toLowerCase().includes(pn));
  } else if (options.conversationTitles && options.conversationTitles.length > 0) {
    const titles = new Set(options.conversationTitles.map((t) => t.toLowerCase()));
    selected = allMemories.filter((m) => titles.has(m.conversation_title.toLowerCase()));
  } else {
    selected = allMemories;
  }

  // Apply limit
  selected.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  const toImport = selected.slice(0, options.limit);

  const matchedConvs = [...new Set(toImport.map((m) => m.conversation_title))];

  let imported = 0;
  let skipped = 0;

  for (const m of toImport) {
    try {
      await options.storeFn(
        m.content,
        ["chatgpt-transfer", `chat:${m.conversation_title.slice(0, 50)}`],
        m.timestamp
      );
      imported++;
    } catch (err: any) {
      // Duplicate or other error — skip
      skipped++;
    }
  }

  return {
    imported,
    skipped,
    conversations_matched: matchedConvs,
  };
}
