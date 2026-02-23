import type { EmbeddingClient } from "../llm/embedding.js";
import { loadAgentConfig } from "../storage/agentConfig.js";
import { loadIndex, type IndexEntry } from "./embeddingIndex.js";

let embeddingClient: EmbeddingClient | null = null;

export function setEmbeddingClient(client: EmbeddingClient | null): void {
  embeddingClient = client;
}

export function getEmbeddingClient(): EmbeddingClient | null {
  return embeddingClient;
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

function keywordScore(queryTokens: string[], entry: IndexEntry): number {
  const target = `${entry.title} ${entry.textSnippet}`.toLowerCase();
  const targetTokens = new Set(tokenize(target));
  let score = 0;
  for (const t of queryTokens) {
    if (targetTokens.has(t)) score++;
  }
  return score;
}

export interface GetRelevantTitlesOptions {
  limit: number;
  useEmbeddings?: boolean;
}

/**
 * Return up to `limit` note titles most relevant to queryText.
 * Uses embedding similarity when useEmbeddings and embedding client available; else keyword fallback.
 */
export async function getRelevantTitles(
  vaultPath: string,
  queryText: string,
  options: GetRelevantTitlesOptions
): Promise<string[]> {
  const config = await loadAgentConfig(vaultPath);
  const index = await loadIndex(vaultPath);
  if (index.entries.length === 0) return [];

  const limit = Math.max(1, options.limit);
  const useEmbeddings =
    options.useEmbeddings !== undefined ? options.useEmbeddings : config.useEmbeddings;

  const entriesWithEmbedding = index.entries.filter((e) => e.embedding && e.embedding.length > 0);

  if (
    useEmbeddings &&
    embeddingClient &&
    entriesWithEmbedding.length > 0 &&
    queryText.trim().length > 0
  ) {
    try {
      const queryEmbedding = await embeddingClient.embed(queryText.trim().slice(0, 8000));
      const scored = entriesWithEmbedding.map((e) => ({
        title: e.title,
        score: cosineSimilarity(queryEmbedding, e.embedding!),
      }));
      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, limit).map((s) => s.title);
    } catch {
      // fall through to keyword
    }
  }

  const queryTokens = tokenize(queryText);
  if (queryTokens.length === 0) return index.entries.slice(0, limit).map((e) => e.title);

  const scored = index.entries.map((e) => ({
    title: e.title,
    score: keywordScore(queryTokens, e),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.title);
}

/**
 * Compute cosine similarity between two vectors (for dedup check). Exported for use in insights.
 */
export function similarity(a: number[], b: number[]): number {
  return cosineSimilarity(a, b);
}
