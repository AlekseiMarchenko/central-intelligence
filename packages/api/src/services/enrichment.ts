/**
 * @deprecated Replaced by fact-extraction.ts (structured fact decomposition).
 * The store() pipeline in memories.ts now uses extractFacts() + entity resolution instead.
 * This file is kept for backward compatibility but is no longer called.
 *
 * Original purpose: simple entity + preference extraction via GPT-4o-mini.
 * New approach: full fact decomposition with structured facts, entity resolution,
 * co-occurrence scoring, and knowledge graph links.
 */

import OpenAI from "openai";
import { sql } from "../db/connection.js";

let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!client) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return null as any; // Enrichment disabled without key
    client = new OpenAI({ apiKey });
  }
  return client;
}

export interface Enrichments {
  entities: string[];
  preferences: string[];
}

const EXTRACT_PROMPT = `Extract structured data from this text. Return valid JSON only.

Extract:
1. entities: Named people, places, organizations, products, technologies mentioned. Use full names.
2. preferences: Any user preferences, opinions, habits, likes/dislikes expressed. Write as short phrases starting with "prefers", "likes", "dislikes", "uses", etc.

Return: {"entities": [...], "preferences": [...]}
Return {"entities": [], "preferences": []} if none found.`;

/**
 * Extract entities and preferences from memory content via GPT-4o-mini.
 */
async function extractEnrichments(content: string): Promise<Enrichments> {
  const openai = getClient();
  if (!openai) return { entities: [], preferences: [] };

  try {
    const res = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: EXTRACT_PROMPT },
        { role: "user", content: content.substring(0, 4000) }, // Cap input to control cost
      ],
      response_format: { type: "json_object" },
      temperature: 0,
      max_tokens: 256,
    });

    const text = res.choices[0]?.message?.content?.trim();
    if (!text) return { entities: [], preferences: [] };

    const parsed = JSON.parse(text) as Enrichments;
    return {
      entities: Array.isArray(parsed.entities) ? parsed.entities.filter(Boolean) : [],
      preferences: Array.isArray(parsed.preferences) ? parsed.preferences.filter(Boolean) : [],
    };
  } catch (err: any) {
    console.warn("[enrichment] Extraction failed:", err.message);
    return { entities: [], preferences: [] };
  }
}

/**
 * Fire-and-forget enrichment for a memory.
 * Called from store() after INSERT completes. Does not block the response.
 *
 * 1. Calls GPT-4o-mini to extract entities + preferences
 * 2. Updates the memory row with structured data
 * 3. Appends extracted terms to content_tsv for BM25 discoverability
 */
export function enrichMemoryAsync(memoryId: string, plaintext: string): void {
  if (!process.env.OPENAI_API_KEY) return; // Silently skip if no key

  extractEnrichments(plaintext)
    .then(async ({ entities, preferences }) => {
      if (entities.length === 0 && preferences.length === 0) {
        // Nothing to enrich, just mark as processed
        await sql`UPDATE memories SET enriched_at = now() WHERE id = ${memoryId}`;
        return;
      }

      // Build searchable text from entities + preferences
      // This gets appended to content_tsv so BM25 can find these terms
      const enrichedText = [...entities, ...preferences].join(" ");

      await sql`
        UPDATE memories SET
          entities = ${JSON.stringify(entities)}::jsonb,
          preferences = ${JSON.stringify(preferences)}::jsonb,
          enriched_at = now(),
          content_tsv = content_tsv || to_tsvector('english', ${enrichedText})
        WHERE id = ${memoryId}
      `;
    })
    .catch((err) => {
      console.warn(`[enrichment] Failed for memory ${memoryId}:`, err.message);
    });
}
