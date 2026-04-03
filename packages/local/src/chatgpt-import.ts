import { readFileSync } from "fs";
import { createHash } from "crypto";

/**
 * Parse a ChatGPT data export (Settings > Data controls > Export data).
 *
 * The export is a ZIP containing conversations.json with this structure:
 * [
 *   {
 *     "title": "conversation title",
 *     "create_time": 1234567890.123,
 *     "mapping": {
 *       "uuid": {
 *         "message": {
 *           "author": { "role": "user" | "assistant" | "system" },
 *           "content": { "parts": ["text content"] },
 *           "create_time": 1234567890.123
 *         }
 *       }
 *     }
 *   }
 * ]
 *
 * This parser extracts unique facts/decisions from conversations.
 * It focuses on user messages that look like instructions, preferences,
 * or decisions (not questions or casual chat).
 */

export interface ChatGPTMemory {
  content: string;
  conversation_title: string;
  timestamp: string;
  content_hash: string;
}

/**
 * Parse conversations.json from a ChatGPT data export.
 * Returns extracted memories sorted by recency.
 */
export function parseChatGPTExport(filePath: string): {
  memories: ChatGPTMemory[];
  stats: { conversations: number; messages: number; extracted: number };
} {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch (err: any) {
    throw new Error(`Cannot read ChatGPT export: ${err.message}`);
  }

  let conversations: any[];
  try {
    conversations = JSON.parse(raw);
  } catch {
    throw new Error("Invalid JSON. Expected conversations.json from ChatGPT data export.");
  }

  if (!Array.isArray(conversations)) {
    throw new Error("Expected an array of conversations.");
  }

  const memories: ChatGPTMemory[] = [];
  let totalMessages = 0;

  for (const conv of conversations) {
    const title = conv.title || "Untitled";
    const mapping = conv.mapping;
    if (!mapping || typeof mapping !== "object") continue;

    for (const node of Object.values(mapping) as any[]) {
      const msg = node?.message;
      if (!msg) continue;
      if (msg.author?.role !== "user") continue;

      totalMessages++;

      const parts = msg.content?.parts;
      if (!Array.isArray(parts)) continue;

      const text = parts.filter((p: any) => typeof p === "string").join("\n").trim();
      if (!text) continue;

      // Filter for messages that look like instructions, preferences, or decisions.
      // Skip short messages (likely questions/acknowledgments) and very long ones (code dumps).
      if (text.length < 30 || text.length > 2000) continue;

      // Heuristic: skip messages that are mostly questions
      const questionMarks = (text.match(/\?/g) || []).length;
      const sentences = text.split(/[.!?\n]/).filter((s) => s.trim().length > 0).length;
      if (sentences > 0 && questionMarks / sentences > 0.5) continue;

      // Heuristic: look for instructional patterns
      const isInstructional =
        /\b(always|never|prefer|use|don't|avoid|make sure|remember|important)\b/i.test(text) ||
        /\b(i want|i need|i like|my preference|my style)\b/i.test(text) ||
        /\b(the project|the codebase|the stack|our team|we use)\b/i.test(text);

      if (!isInstructional) continue;

      const hash = createHash("sha256").update(text).digest("hex").slice(0, 16);
      const timestamp = msg.create_time
        ? new Date(msg.create_time * 1000).toISOString()
        : new Date(conv.create_time * 1000).toISOString();

      memories.push({
        content: text,
        conversation_title: title,
        timestamp,
        content_hash: hash,
      });
    }
  }

  // Deduplicate by content hash
  const seen = new Set<string>();
  const unique = memories.filter((m) => {
    if (seen.has(m.content_hash)) return false;
    seen.add(m.content_hash);
    return true;
  });

  // Sort by most recent first
  unique.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  return {
    memories: unique,
    stats: {
      conversations: conversations.length,
      messages: totalMessages,
      extracted: unique.length,
    },
  };
}
