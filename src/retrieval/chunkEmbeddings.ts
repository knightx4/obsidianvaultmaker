import { readFile, writeFile, mkdir } from "fs/promises";
import path from "path";
import type { EmbeddingClient } from "../llm/embedding.js";
import { similarity } from "./retrieve.js";

const VAULTMAKER_DIR = ".vaultmaker";
const CHUNK_EMB_FILE = "chunkEmbeddings.json";

export interface ChunkEmbeddingEntry {
  chunkId: string;
  sourceId: string;
  embedding: number[];
  textPreview: string;
}

export interface ChunkEmbeddingIndex {
  entries: ChunkEmbeddingEntry[];
  updatedAt: string;
}

function getPath(vaultPath: string): string {
  return path.join(vaultPath, VAULTMAKER_DIR, CHUNK_EMB_FILE);
}

export async function loadChunkEmbeddingIndex(vaultPath: string): Promise<ChunkEmbeddingIndex> {
  try {
    const raw = await readFile(getPath(vaultPath), "utf-8");
    const data = JSON.parse(raw) as ChunkEmbeddingIndex;
    if (!data.entries || !Array.isArray(data.entries)) {
      return { entries: [], updatedAt: new Date().toISOString() };
    }
    return {
      entries: data.entries.filter(
        (e) => e && typeof e.chunkId === "string" && Array.isArray(e.embedding) && e.embedding.length > 0
      ),
      updatedAt: typeof data.updatedAt === "string" ? data.updatedAt : new Date().toISOString(),
    };
  } catch {
    return { entries: [], updatedAt: new Date().toISOString() };
  }
}

export async function saveChunkEmbeddingIndex(vaultPath: string, index: ChunkEmbeddingIndex): Promise<void> {
  const dir = path.join(vaultPath, VAULTMAKER_DIR);
  await mkdir(dir, { recursive: true });
  await writeFile(
    getPath(vaultPath),
    JSON.stringify({ ...index, updatedAt: new Date().toISOString() }, null, 0),
    "utf-8"
  );
}

export async function indexChunkEmbedding(
  vaultPath: string,
  chunkId: string,
  sourceId: string,
  text: string,
  embedding: number[]
): Promise<void> {
  const index = await loadChunkEmbeddingIndex(vaultPath);
  const preview = text.slice(0, 300);
  const entry: ChunkEmbeddingEntry = {
    chunkId,
    sourceId,
    embedding,
    textPreview: preview,
  };
  const i = index.entries.findIndex((e) => e.chunkId === chunkId);
  if (i >= 0) index.entries[i] = entry;
  else index.entries.push(entry);
  await saveChunkEmbeddingIndex(vaultPath, index);
}

/**
 * Embed and store chunks that are missing from the chunk embedding index.
 */
export async function ensureChunkEmbeddings(
  vaultPath: string,
  chunks: Array<{ chunkId: string; sourceId: string; text: string }>,
  client: EmbeddingClient | null,
  enabled: boolean
): Promise<void> {
  if (!enabled || !client || chunks.length === 0) return;
  const index = await loadChunkEmbeddingIndex(vaultPath);
  const existing = new Set(index.entries.map((e) => e.chunkId));
  for (const c of chunks) {
    if (existing.has(c.chunkId)) continue;
    try {
      const emb = await client.embed(c.text.slice(0, 8000));
      await indexChunkEmbedding(vaultPath, c.chunkId, c.sourceId, c.text, emb);
      existing.add(c.chunkId);
    } catch {
      // skip
    }
  }
}

export async function retrieveRelevantChunkIds(
  vaultPath: string,
  queryText: string,
  client: EmbeddingClient | null,
  limit: number,
  useEmbeddings: boolean
): Promise<Array<{ chunkId: string; sourceId: string; score: number }>> {
  const index = await loadChunkEmbeddingIndex(vaultPath);
  const lim = Math.max(1, limit);
  const withEmb = index.entries.filter((e) => e.embedding && e.embedding.length > 0);

  if (useEmbeddings && client && withEmb.length > 0 && queryText.trim().length > 0) {
    try {
      const q = await client.embed(queryText.trim().slice(0, 8000));
      const scored = withEmb.map((e) => ({
        chunkId: e.chunkId,
        sourceId: e.sourceId,
        score: similarity(q, e.embedding),
      }));
      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, lim);
    } catch {
      // fall through
    }
  }

  const tokens = queryText
    .toLowerCase()
    .replace(/\s+/g, " ")
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
  if (tokens.length === 0) {
    return index.entries.slice(0, lim).map((e) => ({ chunkId: e.chunkId, sourceId: e.sourceId, score: 0 }));
  }
  const scored = index.entries.map((e) => {
    const target = `${e.chunkId} ${e.textPreview}`.toLowerCase();
    let score = 0;
    for (const t of tokens) {
      if (target.includes(t)) score++;
    }
    return { chunkId: e.chunkId, sourceId: e.sourceId, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, lim);
}
