import type { EmbeddingClient } from "./embedding.js";

const VOYAGE_EMBED_URL = "https://api.voyageai.com/v1/embeddings";
const DEFAULT_MODEL = "voyage-3-large";

interface VoyageEmbeddingResponse {
  data?: Array<{ embedding?: number[] }>;
  error?: { message?: string };
}

/**
 * Voyage AI embeddings (Anthropic does not offer a public embedding API).
 * Set VOYAGE_API_KEY. Optional: VOYAGE_EMBEDDING_MODEL (default voyage-3-large).
 */
export function createVoyageEmbeddingClient(apiKey: string, model?: string): EmbeddingClient {
  const resolvedModel = model?.trim() || process.env.VOYAGE_EMBEDDING_MODEL?.trim() || DEFAULT_MODEL;

  return {
    async embed(text: string): Promise<number[]> {
      const res = await fetch(VOYAGE_EMBED_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          input: text.slice(0, 16000),
          model: resolvedModel,
          input_type: "document",
        }),
      });
      const json = (await res.json()) as VoyageEmbeddingResponse;
      if (!res.ok) {
        throw new Error(json.error?.message ?? `Voyage embeddings HTTP ${res.status}`);
      }
      const vec = json.data?.[0]?.embedding;
      if (!vec || !Array.isArray(vec)) throw new Error("Empty embedding response from Voyage");
      return vec;
    },
  };
}
