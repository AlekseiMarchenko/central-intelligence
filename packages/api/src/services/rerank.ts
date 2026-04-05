/**
 * Cross-encoder reranking via Cohere Rerank API.
 * Graceful fallback: if COHERE_API_KEY is not set, returns documents in original order.
 */

const COHERE_API_KEY = process.env.COHERE_API_KEY;
const RERANK_MODEL = "rerank-v3.5";
const RERANK_API_URL = "https://api.cohere.com/v2/rerank";

export interface RerankDocument {
  id: string;
  content: string;
}

export interface RerankResult {
  id: string;
  score: number;
}

/**
 * Rerank documents using a cross-encoder model.
 * Falls back to passthrough scoring if Cohere API key is not configured.
 */
export async function rerank(
  query: string,
  documents: RerankDocument[],
  topN: number = 20,
): Promise<RerankResult[]> {
  // Fallback: no reranking if API key not set or too few docs
  if (!COHERE_API_KEY || documents.length === 0) {
    return documents
      .slice(0, topN)
      .map((d, i) => ({ id: d.id, score: 1 - i / Math.max(documents.length, 1) }));
  }

  // If fewer docs than topN, no need to rerank
  if (documents.length <= topN) {
    return documents.map((d, i) => ({ id: d.id, score: 1 - i / Math.max(documents.length, 1) }));
  }

  try {
    const res = await fetch(RERANK_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${COHERE_API_KEY}`,
      },
      body: JSON.stringify({
        model: RERANK_MODEL,
        query,
        documents: documents.map((d) => d.content),
        top_n: topN,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      console.warn(`[rerank] Cohere API error (${res.status}): ${text}`);
      // Fallback to original order
      return documents
        .slice(0, topN)
        .map((d, i) => ({ id: d.id, score: 1 - i / documents.length }));
    }

    const data = (await res.json()) as {
      results: Array<{ index: number; relevance_score: number }>;
    };

    return data.results.map((r) => ({
      id: documents[r.index].id,
      score: r.relevance_score,
    }));
  } catch (err: any) {
    console.warn("[rerank] Cohere API call failed:", err.message);
    // Fallback to original order
    return documents
      .slice(0, topN)
      .map((d, i) => ({ id: d.id, score: 1 - i / documents.length }));
  }
}
