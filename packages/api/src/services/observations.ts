/**
 * Observation consolidation — auto-generated summaries from fact clusters.
 *
 * After enough facts accumulate about an entity or topic, this service
 * synthesizes higher-level observations. These are "pre-computed answers"
 * that match directly via embedding search.
 *
 * Example:
 *   Facts: "User discussed Premiere Pro color grading", "User used Lumetri Panel",
 *          "User edited wedding video in Premiere", "User exported 4K from Premiere"
 *   Observation: "User is an experienced Adobe Premiere Pro user focused on
 *                 color grading and high-resolution editing" (proof_count=4)
 *
 * When someone asks "recommend video editing resources", the observation
 * matches directly — no need to retrieve and synthesize 4 separate facts.
 *
 * Cost: ~$0.0001 per consolidation (GPT-4o-mini, ~500 tokens)
 * Trigger: after each successful fact extraction, checks if any entity
 *          has enough unconsolidated facts to warrant an observation.
 */

import OpenAI from "openai";
import { sql } from "../db/connection.js";
import { embed } from "./embeddings.js";
import { encrypt } from "./encryption.js";

// --- Config ---

const MIN_FACTS_FOR_OBSERVATION = parseInt(process.env.MIN_FACTS_FOR_OBSERVATION || "5");
const MAX_OBSERVATIONS_PER_RUN = parseInt(process.env.MAX_OBSERVATIONS_PER_RUN || "3");

// --- OpenAI client (lazy singleton) ---

let client: OpenAI | null = null;

function getClient(): OpenAI | null {
  if (!client) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return null;
    client = new OpenAI({ apiKey });
  }
  return client;
}

// --- Consolidation prompt ---

const CONSOLIDATION_PROMPT = `You are synthesizing an observation from multiple facts about a topic or entity.

Given a set of facts, produce a single concise observation that captures the key pattern, preference, or characteristic. The observation should:
- Be a self-contained statement (someone reading it alone should understand it)
- Synthesize across facts, not just list them
- Focus on the most useful/actionable insight
- Be 1-2 sentences maximum
- Use the entity/person's name, not pronouns

Return JSON: {"observation": "...", "confidence": 0.0-1.0}
Return {"observation": null, "confidence": 0} if the facts are too unrelated to synthesize.`;

// --- Types ---

export interface ConsolidationResult {
  entityId: string;
  entityName: string;
  observation: string;
  factIds: string[];
  confidence: number;
}

// --- Pure function: determine which entities need consolidation ---

/**
 * Find entities that have enough unconsolidated facts for observation generation.
 * Exported for testing.
 */
export async function findConsolidationCandidates(
  apiKeyId: string,
  agentId: string,
): Promise<Array<{ entityId: string; entityName: string; factCount: number }>> {
  // Find entities with >= MIN_FACTS_FOR_OBSERVATION facts that don't already
  // have a recent observation (observation created in the last 24 hours)
  const candidates = await sql`
    SELECT e.id as entity_id, e.name as entity_name, COUNT(ef.fact_id) as fact_count
    FROM entities e
    JOIN entity_facts ef ON e.id = ef.entity_id
    JOIN fact_units fu ON ef.fact_id = fu.id
    WHERE e.api_key_id = ${apiKeyId}
      AND e.agent_id = ${agentId}
      AND fu.fact_type != 'observation'
      AND fu.is_fallback = false
      AND NOT EXISTS (
        SELECT 1 FROM fact_units obs
        WHERE obs.api_key_id = ${apiKeyId}
          AND obs.agent_id = ${agentId}
          AND obs.fact_type = 'observation'
          AND obs.entities @> to_jsonb(e.name)::jsonb
          AND obs.created_at > now() - interval '24 hours'
      )
    GROUP BY e.id, e.name
    HAVING COUNT(ef.fact_id) >= ${MIN_FACTS_FOR_OBSERVATION}
    ORDER BY COUNT(ef.fact_id) DESC
    LIMIT ${MAX_OBSERVATIONS_PER_RUN}
  `;

  return (candidates as any[]).map((r: any) => ({
    entityId: r.entity_id,
    entityName: r.entity_name,
    factCount: parseInt(r.fact_count),
  }));
}

/**
 * Fetch the unconsolidated facts for an entity (decrypted fact text needed for LLM).
 */
async function fetchFactsForEntity(
  entityId: string,
  rawApiKey: string,
): Promise<Array<{ id: string; factText: string }>> {
  const rows = await sql`
    SELECT fu.id, fu.fact_text
    FROM fact_units fu
    JOIN entity_facts ef ON fu.id = ef.fact_id
    WHERE ef.entity_id = ${entityId}
      AND fu.fact_type != 'observation'
      AND fu.is_fallback = false
    ORDER BY fu.created_at DESC
    LIMIT 20
  `;

  // fact_text is encrypted — we need rawApiKey to decrypt
  const { decrypt } = await import("./encryption.js");
  return (rows as any[]).map((r: any) => ({
    id: r.id,
    factText: decrypt(r.fact_text, rawApiKey),
  }));
}

/**
 * Synthesize an observation from a set of facts via GPT-4o-mini.
 */
async function synthesizeObservation(
  entityName: string,
  facts: string[],
): Promise<{ observation: string; confidence: number } | null> {
  const openai = getClient();
  if (!openai) return null;

  try {
    const factsText = facts.map((f, i) => `${i + 1}. ${f}`).join("\n");
    const res = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: CONSOLIDATION_PROMPT },
        {
          role: "user",
          content: `Entity: "${entityName}"\n\nFacts:\n${factsText}`,
        },
      ],
      response_format: { type: "json_object" },
      temperature: 0,
      max_tokens: 256,
    });

    const text = res.choices[0]?.message?.content?.trim();
    if (!text) return null;

    const parsed = JSON.parse(text);
    if (!parsed.observation || typeof parsed.observation !== "string") return null;

    return {
      observation: parsed.observation,
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.8,
    };
  } catch (err: any) {
    console.warn(`[observations] Synthesis failed for "${entityName}":`, err.message);
    return null;
  }
}

/**
 * Store an observation as a fact_unit with fact_type='observation'.
 */
async function storeObservation(
  apiKeyId: string,
  agentId: string,
  rawApiKey: string,
  memoryId: string,
  observation: string,
  sourceFactIds: string[],
  entityName: string,
): Promise<string | null> {
  try {
    const embedding = await embed(observation);
    const encryptedObs = encrypt(observation, rawApiKey);
    const vecStr = `[${embedding.join(",")}]`;

    const [inserted] = await sql`
      INSERT INTO fact_units (
        memory_id, api_key_id, agent_id, fact_text, fact_type,
        embedding_vec, search_vector, proof_count, source_fact_ids,
        entities
      )
      VALUES (
        ${memoryId}, ${apiKeyId}, ${agentId}, ${encryptedObs}, 'observation',
        ${vecStr}::vector, to_tsvector('english', ${observation}),
        ${sourceFactIds.length}, ${sourceFactIds},
        ${JSON.stringify([entityName])}::jsonb
      )
      RETURNING id
    `;

    console.log(
      `[observations] Created observation for "${entityName}" ` +
        `(proof_count=${sourceFactIds.length}, id=${inserted.id})`,
    );

    return inserted.id;
  } catch (err: any) {
    console.warn(`[observations] Store failed for "${entityName}":`, err.message);
    return null;
  }
}

// --- Main consolidation function ---

/**
 * Run observation consolidation for an api_key + agent.
 * Called after successful fact extraction. Fire-and-forget.
 *
 * Finds entities with enough unconsolidated facts, synthesizes
 * observations, and stores them as fact_units.
 */
export async function consolidateObservations(
  apiKeyId: string,
  agentId: string,
  rawApiKey: string,
  memoryId: string,
): Promise<ConsolidationResult[]> {
  const candidates = await findConsolidationCandidates(apiKeyId, agentId);
  if (candidates.length === 0) return [];

  const results: ConsolidationResult[] = [];

  for (const { entityId, entityName, factCount } of candidates) {
    // Fetch and decrypt facts for this entity
    const facts = await fetchFactsForEntity(entityId, rawApiKey);
    if (facts.length < MIN_FACTS_FOR_OBSERVATION) continue;

    // Synthesize observation
    const synthesis = await synthesizeObservation(
      entityName,
      facts.map((f) => f.factText),
    );
    if (!synthesis) continue;

    // Store as observation fact_unit
    const factIds = facts.map((f) => f.id);
    const obsId = await storeObservation(
      apiKeyId,
      agentId,
      rawApiKey,
      memoryId,
      synthesis.observation,
      factIds,
      entityName,
    );

    if (obsId) {
      results.push({
        entityId,
        entityName,
        observation: synthesis.observation,
        factIds,
        confidence: synthesis.confidence,
      });
    }
  }

  if (results.length > 0) {
    console.log(
      `[observations] Consolidation complete: ${results.length} observations created ` +
        `(${results.map((r) => `"${r.entityName}"`).join(", ")})`,
    );
  }

  return results;
}
