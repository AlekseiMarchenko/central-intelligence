/**
 * Fact decomposition service — structured extraction.
 *
 * Replaces the simple entity+preference extraction in enrichment.ts with
 * full fact decomposition: raw text → structured facts with entities,
 * temporal info, causal relations, and preferences.
 *
 * Each fact becomes a fact_unit row that's individually searchable.
 *
 * Cost: ~$0.0002 per memory (~1000 tokens structured output)
 * Model: GPT-4o-mini with response_format: json_object
 */

import OpenAI from "openai";
import { z } from "zod";

// --- Zod schemas ---

const WhoSchema = z.object({
  name: z.string().min(1),
  relation: z.string().optional(),
});

const WhenSchema = z.object({
  start: z.string().nullable().optional(),
  end: z.string().nullable().optional(),
});

const FactSchema = z.object({
  what: z.string().min(1),
  when: WhenSchema.optional(),
  where: z.string().nullable().optional(),
  who: z.array(WhoSchema).default([]),
  entities: z.array(z.string()).default([]),
  fact_type: z.enum(["world", "experience"]).default("world"),
  causal_relations: z.array(z.string()).default([]),
});

export const ExtractionResultSchema = z.object({
  facts: z.array(FactSchema).default([]),
  preferences: z.array(z.string()).default([]),
});

export type ExtractionResult = z.infer<typeof ExtractionResultSchema>;
export type ExtractedFact = z.infer<typeof FactSchema>;

// --- OpenAI client (lazy singleton, same pattern as enrichment.ts) ---

let client: OpenAI | null = null;

function getClient(): OpenAI | null {
  if (!client) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return null;
    client = new OpenAI({ apiKey });
  }
  return client;
}

// --- Extraction prompt ---

const EXTRACT_PROMPT = `You are a fact extraction engine. Decompose the input text into discrete, atomic facts.

For each fact, extract:
- what: A clear, self-contained sentence stating the fact. Include names, not pronouns.
- when: {start, end} dates if mentioned (ISO 8601 format, e.g. "2025-01-18"). null if no date.
- where: Location if mentioned. null if none.
- who: Array of {name, relation} for people involved. relation is optional (e.g. "colleague", "manager").
- entities: Array of named entities (people, places, orgs, products, technologies) mentioned in this fact.
- fact_type: "experience" if it describes something the user did/felt/saw. "world" for general knowledge or third-party facts.
- causal_relations: Array of effect descriptions if this fact causes or enables something else. Empty if none.

Also extract:
- preferences: Array of short phrases about user opinions/habits/likes/dislikes. Start with "prefers", "likes", "dislikes", "uses", etc.

Return JSON: {"facts": [...], "preferences": [...]}
Return {"facts": [], "preferences": []} if nothing extractable.

Rules:
- One fact per distinct piece of information. "Had lunch and discussed targets" = 2 facts.
- Use full names, not pronouns. "Alice" not "she".
- Keep facts atomic and self-contained. Someone reading one fact should understand it without context.
- Dates in ISO 8601 format when extractable.`;

// --- Core functions ---

/**
 * Parse and validate extraction output. Exported for testing.
 * Recovers partial results: if facts parse but preferences don't, keep facts.
 */
export function parseExtractionResult(raw: unknown): ExtractionResult {
  if (!raw || typeof raw !== "object") {
    return { facts: [], preferences: [] };
  }

  const result = ExtractionResultSchema.safeParse(raw);
  if (result.success) {
    return result.data;
  }

  // Partial recovery: try each field independently
  const obj = raw as Record<string, unknown>;
  let facts: ExtractedFact[] = [];
  let preferences: string[] = [];

  if (Array.isArray(obj.facts)) {
    for (const f of obj.facts) {
      const parsed = FactSchema.safeParse(f);
      if (parsed.success) {
        facts.push(parsed.data);
      }
    }
  }

  if (Array.isArray(obj.preferences)) {
    preferences = obj.preferences.filter(
      (p): p is string => typeof p === "string" && p.length > 0
    );
  }

  return { facts, preferences };
}

/**
 * Extract structured facts from memory content via GPT-4o-mini.
 * Throws on API failure (caller handles retry).
 */
export async function extractFacts(content: string): Promise<ExtractionResult> {
  const openai = getClient();
  if (!openai) {
    return { facts: [], preferences: [] };
  }

  const res = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: EXTRACT_PROMPT },
      { role: "user", content: content.substring(0, 4000) },
    ],
    response_format: { type: "json_object" },
    temperature: 0,
    max_tokens: 1024,
  });

  const text = res.choices[0]?.message?.content?.trim();
  if (!text) {
    return { facts: [], preferences: [] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    console.warn("[fact-extraction] GPT-4o-mini returned invalid JSON");
    return { facts: [], preferences: [] };
  }

  return parseExtractionResult(parsed);
}
