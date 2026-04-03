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

// --- Shared link approach (preferred — no export file needed) ---

/**
 * Fetch a ChatGPT shared conversation link and extract user messages.
 * ChatGPT share links look like: https://chatgpt.com/share/abc123
 * The page contains the full conversation in the HTML.
 */
export async function fetchSharedConversation(url: string): Promise<{
  title: string;
  memories: ParsedMemory[];
  message_count: number;
}> {
  // Validate URL
  if (!url.match(/^https?:\/\/(chat\.openai\.com|chatgpt\.com)\/(share|s)\//)) {
    throw new Error(
      `Not a ChatGPT share link. Expected: https://chatgpt.com/share/...\n` +
      `To share a conversation: open it in ChatGPT → click Share → Copy Link`
    );
  }

  // Fetch the shared page
  const res = await fetch(url, {
    headers: { "User-Agent": "CI-Local/1.1" },
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    if (res.status === 404) {
      throw new Error("Shared conversation not found. The link may have been revoked.");
    }
    throw new Error(`Failed to fetch: HTTP ${res.status}`);
  }

  const html = await res.text();

  // ChatGPT shared pages embed conversation data in a script tag as JSON
  // Look for the __NEXT_DATA__ or similar JSON blob
  let conversationData: any = null;

  // Try __NEXT_DATA__ pattern
  const nextDataMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (nextDataMatch) {
    try {
      const nextData = JSON.parse(nextDataMatch[1]);
      conversationData = nextData?.props?.pageProps?.serverResponse?.data
        || nextData?.props?.pageProps?.data
        || nextData?.props?.pageProps;
    } catch {}
  }

  // Try JSON-LD or other embedded JSON patterns
  if (!conversationData) {
    const jsonMatches = html.match(/<script[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/g);
    if (jsonMatches) {
      for (const match of jsonMatches) {
        const jsonStr = match.replace(/<script[^>]*>/, "").replace(/<\/script>/, "");
        try {
          const data = JSON.parse(jsonStr);
          if (data?.mapping || data?.title || data?.linear_conversation) {
            conversationData = data;
            break;
          }
        } catch {}
      }
    }
  }

  // Fallback: parse the visible HTML for message content
  const title = extractTitle(html, conversationData);
  const memories: ParsedMemory[] = [];
  let messageCount = 0;

  if (conversationData?.mapping) {
    // Structured data available
    for (const node of Object.values(conversationData.mapping) as any[]) {
      const msg = node?.message;
      if (!msg || msg.author?.role !== "user") continue;
      messageCount++;

      const parts = msg.content?.parts;
      if (!Array.isArray(parts)) continue;
      const text = parts.filter((p: any) => typeof p === "string").join("\n").trim();

      const memory = extractMemory(text, title, msg.create_time);
      if (memory) memories.push(memory);
    }
  } else if (conversationData?.linear_conversation) {
    // Alternative format
    for (const item of conversationData.linear_conversation) {
      const msg = item?.message;
      if (!msg || msg.author?.role !== "user") continue;
      messageCount++;

      const parts = msg.content?.parts;
      if (!Array.isArray(parts)) continue;
      const text = parts.filter((p: any) => typeof p === "string").join("\n").trim();

      const memory = extractMemory(text, title, msg.create_time);
      if (memory) memories.push(memory);
    }
  } else {
    // Last resort: extract text from HTML
    const userMessages = extractMessagesFromHtml(html);
    messageCount = userMessages.length;
    for (const text of userMessages) {
      const memory = extractMemory(text, title);
      if (memory) memories.push(memory);
    }
  }

  // Deduplicate
  const seen = new Set<string>();
  const unique = memories.filter((m) => {
    if (seen.has(m.content_hash)) return false;
    seen.add(m.content_hash);
    return true;
  });

  return { title, memories: unique, message_count: messageCount };
}

/**
 * Transfer memories from multiple shared links.
 */
export async function transferFromLinks(options: {
  urls: string[];
  limit: number;
  storeFn: (content: string, tags: string[], timestamp: string) => Promise<any>;
}): Promise<{
  imported: number;
  skipped: number;
  conversations: { title: string; memories: number; messages: number }[];
  errors: string[];
}> {
  const conversations: { title: string; memories: number; messages: number }[] = [];
  const allMemories: ParsedMemory[] = [];
  const errors: string[] = [];

  for (const url of options.urls) {
    try {
      const result = await fetchSharedConversation(url);
      conversations.push({
        title: result.title,
        memories: result.memories.length,
        messages: result.message_count,
      });
      allMemories.push(...result.memories);
    } catch (err: any) {
      errors.push(`${url}: ${err.message}`);
    }
  }

  // Apply limit and import
  const toImport = allMemories.slice(0, options.limit);
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
    } catch {
      skipped++;
    }
  }

  return { imported, skipped, conversations, errors };
}

// --- Helpers ---

function extractMemory(
  text: string,
  title: string,
  createTime?: number
): ParsedMemory | null {
  if (!text || text.length < 30 || text.length > 2000) return null;

  // Skip questions
  const questionMarks = (text.match(/\?/g) || []).length;
  const sentences = text.split(/[.!?\n]/).filter((s) => s.trim().length > 0).length;
  if (sentences > 0 && questionMarks / sentences > 0.5) return null;

  // Instructional filter
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

function extractTitle(html: string, data: any): string {
  if (data?.title) return data.title;
  const titleMatch = html.match(/<title>([^<]+)<\/title>/);
  if (titleMatch) {
    const title = titleMatch[1].replace(" - ChatGPT", "").replace("ChatGPT - ", "").trim();
    if (title && title !== "ChatGPT") return title;
  }
  return "Untitled Conversation";
}

function extractMessagesFromHtml(html: string): string[] {
  // Strip HTML tags, look for message-like blocks
  // This is a rough fallback for when structured data isn't available
  const messages: string[] = [];
  const textBlocks = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, "\n")
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter((b) => b.length > 30 && b.length < 2000);

  // Rough heuristic: every other block might be user vs assistant
  // This is unreliable but better than nothing
  for (const block of textBlocks) {
    if (/\b(always|never|prefer|use|i want|i need|the project)\b/i.test(block)) {
      messages.push(block);
    }
  }

  return messages;
}

// --- File-based approach (legacy, for users who already exported) ---

export async function listChatGPTConversations(filter?: string): Promise<{
  conversations: { title: string; instructional_count: number; date: string; project?: string }[];
  projects: string[];
  total_memories: number;
  export_path: string;
  has_export: boolean;
}> {
  if (!existsSync(CONVERSATIONS_PATH)) {
    return {
      conversations: [],
      projects: [],
      total_memories: 0,
      export_path: CONVERSATIONS_PATH,
      has_export: false,
    };
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

  const projects = [...new Set(convList.map((c) => c.project).filter(Boolean))] as string[];

  return {
    conversations: convList.slice(0, 20),
    projects,
    total_memories: allMemories.length,
    export_path: CONVERSATIONS_PATH,
    has_export: true,
  };
}

export async function transferChatGPT(options: {
  conversationTitles?: string[];
  projectName?: string;
  limit: number;
  storeFn: (content: string, tags: string[], timestamp: string) => Promise<any>;
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
      await options.storeFn(m.content, ["chatgpt-transfer", `chat:${m.conversation_title.slice(0, 50)}`], m.timestamp);
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
