let pipeline: any = null;
let extractor: any = null;

async function getExtractor() {
  if (extractor) return extractor;

  // Dynamic import to avoid top-level await
  const { pipeline: createPipeline } = await import("@xenova/transformers");
  extractor = await createPipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", {
    quantized: true, // Use quantized model for speed (~25MB vs ~90MB)
  });

  return extractor;
}

export async function embed(text: string): Promise<number[]> {
  const ext = await getExtractor();

  // Truncate to ~512 tokens (~2000 chars) — model max is 256 tokens but we let it truncate
  const truncated = text.slice(0, 2000);

  const output = await ext(truncated, {
    pooling: "mean",
    normalize: true,
  });

  // Convert to regular array
  return Array.from(output.data as Float32Array);
}

export function embeddingFromBuffer(buf: Buffer): number[] {
  return Array.from(new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4));
}
