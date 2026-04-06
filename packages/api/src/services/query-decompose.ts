/**
 * Query decomposition — expand a complex query into sub-queries before retrieval.
 *
 * "Recommend video editing resources" becomes:
 * - "video editing resources recommendations"  (original)
 * - "what video editor does the user prefer"   (preference probe)
 * - "user video editing tools software"        (entity probe)
 *
 * This bridges the semantic gap between what the user asks and how the
 * answer was originally stored. Runs one GPT-4o-mini call per recall.
 *
 * Cost: ~$0.00005 per recall (~300 tokens)
 * Latency: ~300-500ms added to recall
 */

import OpenAI from "openai";

let client: OpenAI | null = null;

function getClient(): OpenAI | null {
  if (!client) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return null;
    client = new OpenAI({ apiKey });
  }
  return client;
}

const DECOMPOSE_PROMPT = `You are helping a memory search system find relevant past conversations and facts.

Given a user's query, generate 2-3 additional search queries that would help find relevant memories. Think about:
- What preferences or habits might be relevant?
- What specific entities (people, tools, places) might be mentioned in related memories?
- What alternative phrasings might the original information be stored under?

Return a JSON array of strings. Keep each query short (5-15 words).
Return just the additional queries, not the original.`;

/**
 * Decompose a query into sub-queries for broader retrieval.
 * Returns the original query plus 2-3 expanded queries.
 * Falls back to just the original query if the LLM call fails or is unavailable.
 */
export async function decomposeQuery(query: string): Promise<string[]> {
  const openai = getClient();
  if (!openai) return [query];

  try {
    const res = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: DECOMPOSE_PROMPT },
        { role: "user", content: query },
      ],
      response_format: { type: "json_object" },
      temperature: 0,
      max_tokens: 128,
    });

    const text = res.choices[0]?.message?.content?.trim();
    if (!text) return [query];

    const parsed = JSON.parse(text);
    const subQueries = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed.queries)
        ? parsed.queries
        : [];

    // Return original + sub-queries (max 3 additional)
    return [query, ...subQueries.slice(0, 3).filter(Boolean)];
  } catch {
    return [query];
  }
}
