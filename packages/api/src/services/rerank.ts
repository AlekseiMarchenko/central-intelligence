/**
 * Cross-encoder reranking — local ONNX model with Cohere fallback.
 *
 * Priority chain:
 * 1. Local ONNX cross-encoder (ms-marco-MiniLM-L-6-v2 via @xenova/transformers)
 *    - Zero per-request cost, ~80ms for 100 pairs on CPU
 *    - Model auto-downloaded on first use, cached locally
 * 2. Cohere Rerank API (if COHERE_API_KEY set and ONNX fails)
 *    - ~$0.00002 per rerank call
 * 3. Passthrough (original order with linear score decay)
 */

// --- Types ---

export interface RerankDocument {
  id: string;
  content: string;
}

export interface RerankResult {
  id: string;
  score: number;
}

// --- ONNX cross-encoder (lazy-loaded) ---

let _onnxPipeline: any = null;
let _onnxFailed = false; // Don't retry ONNX after a load failure within this process

async function getOnnxPipeline(): Promise<any> {
  if (_onnxFailed) return null;
  if (_onnxPipeline) return _onnxPipeline;

  try {
    // Dynamic import — @xenova/transformers is ESM-compatible
    const { pipeline, env } = await import("@xenova/transformers");

    // Use the same cache dir as the Docker build pre-cache step
    const cacheDir = process.env.ONNX_MODEL_CACHE_DIR || process.env.TRANSFORMERS_CACHE || "/app/.model-cache";
    env.cacheDir = cacheDir;

    // Load the cross-encoder model
    // Uses "text-classification" pipeline which handles (query, document) pairs
    console.log("[rerank] Loading local ONNX cross-encoder model...");
    _onnxPipeline = await pipeline(
      "text-classification",
      "Xenova/ms-marco-MiniLM-L-6-v2",
      { quantized: true }, // Use quantized model (~30MB instead of ~80MB)
    );
    console.log("[rerank] ONNX cross-encoder loaded successfully");
    return _onnxPipeline;
  } catch (err: any) {
    console.warn("[rerank] ONNX model load failed, falling back to Cohere:", err.message);
    _onnxFailed = true;
    return null;
  }
}

/**
 * Score query-document pairs using the local ONNX cross-encoder.
 * Returns null if ONNX is unavailable (triggers Cohere fallback).
 */
async function onnxRerank(
  query: string,
  documents: RerankDocument[],
  topN: number,
): Promise<RerankResult[] | null> {
  const classifier = await getOnnxPipeline();
  if (!classifier) return null;

  try {
    // Score each (query, document) pair through the cross-encoder
    const pairs = documents.map((d) => ({
      text: query,
      text_pair: d.content.substring(0, 512), // BERT models max 512 tokens
    }));

    const scores: Array<{ id: string; score: number }> = [];

    // Process in batches of 32 to avoid memory pressure
    const BATCH_SIZE = 32;
    for (let i = 0; i < pairs.length; i += BATCH_SIZE) {
      const batch = pairs.slice(i, i + BATCH_SIZE);
      const batchDocs = documents.slice(i, i + BATCH_SIZE);

      const results = await Promise.all(
        batch.map((pair) =>
          classifier(pair.text, { text_pair: pair.text_pair, topk: null })
        ),
      );

      for (let j = 0; j < results.length; j++) {
        // Cross-encoder output: [{label: "LABEL_0", score: 0.x}, {label: "LABEL_1", score: 0.y}]
        // LABEL_1 is the "relevant" class
        const result = results[j];
        const relevantScore = Array.isArray(result)
          ? (result.find((r: any) => r.label === "LABEL_1")?.score ?? result[0]?.score ?? 0)
          : (result?.score ?? 0);
        scores.push({ id: batchDocs[j].id, score: relevantScore });
      }
    }

    // Sort by score descending, take topN
    scores.sort((a, b) => b.score - a.score);
    return scores.slice(0, topN);
  } catch (err: any) {
    console.warn("[rerank] ONNX inference failed:", err.message);
    return null; // Trigger Cohere fallback
  }
}

// --- Cohere fallback ---

const COHERE_API_KEY = process.env.COHERE_API_KEY;
const RERANK_MODEL = "rerank-v3.5";
const RERANK_API_URL = "https://api.cohere.com/v2/rerank";

async function cohereRerank(
  query: string,
  documents: RerankDocument[],
  topN: number,
): Promise<RerankResult[] | null> {
  if (!COHERE_API_KEY) return null;

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
      return null;
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
    return null;
  }
}

// --- Passthrough fallback ---

function passthroughRerank(
  documents: RerankDocument[],
  topN: number,
): RerankResult[] {
  return documents
    .slice(0, topN)
    .map((d, i) => ({ id: d.id, score: 1 - i / Math.max(documents.length, 1) }));
}

// --- Main rerank function (fallback chain) ---

/**
 * Rerank documents using cross-encoder models.
 * Fallback chain: ONNX local → Cohere API → passthrough.
 */
export async function rerank(
  query: string,
  documents: RerankDocument[],
  topN: number = 20,
): Promise<RerankResult[]> {
  if (documents.length === 0) return [];

  // If fewer docs than topN, no real reranking needed
  if (documents.length <= topN) {
    return documents.map((d, i) => ({
      id: d.id,
      score: 1 - i / Math.max(documents.length, 1),
    }));
  }

  // Try ONNX local model first
  const onnxResult = await onnxRerank(query, documents, topN);
  if (onnxResult) {
    return onnxResult;
  }

  // Try Cohere API
  const cohereResult = await cohereRerank(query, documents, topN);
  if (cohereResult) {
    return cohereResult;
  }

  // Final fallback: passthrough
  return passthroughRerank(documents, topN);
}

// --- Exported for testing ---

export { onnxRerank as _onnxRerank, cohereRerank as _cohereRerank, passthroughRerank as _passthroughRerank };
