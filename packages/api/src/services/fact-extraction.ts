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
import { checkOpenAiBudget } from "./query-decompose.js";

// --- Zod schemas (lenient: coerce malformed fields instead of rejecting) ---

const WhoSchema = z.object({
  name: z.string().min(1),
  relation: z.string().optional(),
});

/** Coerce who field: string → [{name: string}], object → [object] */
function coerceWho(val: unknown): z.infer<typeof WhoSchema>[] {
  if (!val) return [];
  if (typeof val === "string") return [{ name: val }];
  if (Array.isArray(val)) {
    return val.flatMap((item) => {
      if (typeof item === "string") return [{ name: item }];
      if (item && typeof item === "object" && "name" in item) {
        const parsed = WhoSchema.safeParse(item);
        return parsed.success ? [parsed.data] : [];
      }
      return [];
    });
  }
  if (typeof val === "object" && val !== null && "name" in val) {
    const parsed = WhoSchema.safeParse(val);
    return parsed.success ? [parsed.data] : [];
  }
  return [];
}

/** Coerce when field: string → {start: string}, null/missing → undefined */
function coerceWhen(val: unknown): { start?: string | null; end?: string | null } | undefined {
  if (!val) return undefined;
  if (typeof val === "string") return { start: val, end: null };
  if (typeof val === "object" && val !== null) {
    const obj = val as Record<string, unknown>;
    return {
      start: typeof obj.start === "string" ? obj.start : null,
      end: typeof obj.end === "string" ? obj.end : null,
    };
  }
  return undefined;
}

/** Coerce string arrays: single string → [string], mixed arrays → filter strings */
function coerceStringArray(val: unknown): string[] {
  if (!val) return [];
  if (typeof val === "string") return [val];
  if (Array.isArray(val)) return val.filter((v): v is string => typeof v === "string" && v.length > 0);
  return [];
}

const FactSchema = z.object({
  what: z.string().min(1),
  when: z.any().optional(),
  where: z.string().nullable().optional(),
  who: z.any().default([]),
  entities: z.any().default([]),
  topics: z.any().default([]),
  fact_type: z.enum(["world", "experience"]).default("world"),
  causal_relations: z.any().default([]),
});

export const ExtractionResultSchema = z.object({
  facts: z.array(z.any()).default([]),
  preferences: z.any().default([]),
});

/** Cleaned fact after coercion */
export interface ExtractedFact {
  what: string;
  when?: { start?: string | null; end?: string | null };
  where?: string | null;
  who: Array<{ name: string; relation?: string }>;
  entities: string[];
  topics: string[];
  fact_type: "world" | "experience";
  causal_relations: string[];
}

export interface ExtractionResult {
  facts: ExtractedFact[];
  preferences: string[];
}

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
- topics: Array of 2-5 topic labels describing what this fact is about. Use short descriptive phrases like "career advice", "restaurant dining", "photography workshop", "work frustration", "coffee tasting", "investment strategy", "running training", "family health". These help with keyword search.
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
 * Parse and coerce extraction output. Exported for testing.
 *
 * Aggressively coerces malformed fields instead of dropping facts:
 * - who: "Alice" → [{name: "Alice"}]
 * - entities: "Paris" → ["Paris"]
 * - when: "2025-01-18" → {start: "2025-01-18"}
 * - fact_type: "unknown" → "world" (default)
 *
 * The only required field is `what` (the fact text). Everything else
 * is best-effort. A fact with just `what` is still useful for search.
 */
export function parseExtractionResult(raw: unknown): ExtractionResult {
  if (!raw || typeof raw !== "object") {
    return { facts: [], preferences: [] };
  }

  const obj = raw as Record<string, unknown>;
  const facts: ExtractedFact[] = [];

  // Coerce facts array
  const rawFacts = Array.isArray(obj.facts) ? obj.facts : [];
  for (const f of rawFacts) {
    if (!f || typeof f !== "object") continue;
    const fact = f as Record<string, unknown>;

    // `what` is the only required field
    const what = typeof fact.what === "string" ? fact.what.trim() : "";
    if (!what) continue;

    // Coerce fact_type
    let factType: "world" | "experience" = "world";
    if (fact.fact_type === "experience") factType = "experience";

    facts.push({
      what,
      when: coerceWhen(fact.when),
      where: typeof fact.where === "string" ? fact.where : null,
      who: coerceWho(fact.who),
      entities: coerceStringArray(fact.entities),
      topics: coerceStringArray(fact.topics),
      fact_type: factType,
      causal_relations: coerceStringArray(fact.causal_relations),
    });
  }

  // Coerce preferences
  const preferences = coerceStringArray(obj.preferences);

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

  if (!checkOpenAiBudget()) {
    console.warn("[fact-extraction] OpenAI budget exceeded, skipping extraction");
    return { facts: [], preferences: [] };
  }

  // 30s timeout on the OpenAI call itself — if the server accepts the connection
  // but never responds, the SDK hangs forever without this.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

  let res;
  try {
    res = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: EXTRACT_PROMPT },
        { role: "user", content: content.substring(0, 4000) },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "fact_extraction",
          strict: true,
          schema: {
          type: "object",
          properties: {
            facts: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  what: { type: "string" },
                  when: {
                    type: "object",
                    properties: {
                      start: { type: ["string", "null"] },
                      end: { type: ["string", "null"] },
                    },
                    required: ["start", "end"],
                    additionalProperties: false,
                  },
                  where: { type: ["string", "null"] },
                  who: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        name: { type: "string" },
                        relation: { type: ["string", "null"] },
                      },
                      required: ["name", "relation"],
                      additionalProperties: false,
                    },
                  },
                  entities: { type: "array", items: { type: "string" } },
                  topics: { type: "array", items: { type: "string" } },
                  fact_type: { type: "string", enum: ["world", "experience"] },
                  causal_relations: { type: "array", items: { type: "string" } },
                },
                required: ["what", "when", "where", "who", "entities", "topics", "fact_type", "causal_relations"],
                additionalProperties: false,
              },
            },
            preferences: { type: "array", items: { type: "string" } },
          },
          required: ["facts", "preferences"],
          additionalProperties: false,
        },
      },
    },
    temperature: 0,
    max_tokens: 2048,
  }, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }

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
