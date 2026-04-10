import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const MODEL = "text-embedding-3-small";
const EMBED_TIMEOUT_MS = 15_000; // 15s timeout per embedding call

export async function embed(text: string): Promise<number[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), EMBED_TIMEOUT_MS);
  try {
    const response = await openai.embeddings.create(
      { model: MODEL, input: text },
      { signal: controller.signal },
    );
    return response.data[0].embedding;
  } finally {
    clearTimeout(timeout);
  }
}

export async function embedBatch(texts: string[]): Promise<number[][]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), EMBED_TIMEOUT_MS);
  try {
    const response = await openai.embeddings.create(
      { model: MODEL, input: texts },
      { signal: controller.signal },
    );
    return response.data.map((d) => d.embedding);
  } finally {
    clearTimeout(timeout);
  }
}

export function embeddingTokenEstimate(text: string): number {
  // Rough estimate: ~4 chars per token
  return Math.ceil(text.length / 4);
}
