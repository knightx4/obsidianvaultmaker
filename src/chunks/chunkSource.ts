import { writeFile, mkdir, readFile } from "fs/promises";
import path from "path";

const VAULTMAKER_DIR = ".vaultmaker";
const CHUNKS_SUBDIR = "chunks";

export interface TextChunk {
  chunkId: string;
  sourceId: string;
  index: number;
  startOffset: number;
  endOffset: number;
  text: string;
}

export interface ChunkFile {
  sourceId: string;
  maxChunkChars: number;
  chunks: TextChunk[];
  updatedAt: string;
}

function chunksDir(vaultPath: string): string {
  return path.join(vaultPath, VAULTMAKER_DIR, CHUNKS_SUBDIR);
}

function chunkIdFor(sourceId: string, index: number): string {
  return `${sourceId}-c${index}`;
}

/**
 * Deterministic chunking: same text + maxLen produces same boundaries (paragraph-aware).
 */
export function chunkSourceText(sourceId: string, text: string, maxLen: number): TextChunk[] {
  if (text.length <= maxLen) {
    return [
      {
        chunkId: chunkIdFor(sourceId, 0),
        sourceId,
        index: 0,
        startOffset: 0,
        endOffset: text.length,
        text,
      },
    ];
  }
  const chunks: TextChunk[] = [];
  let start = 0;
  let idx = 0;
  while (start < text.length) {
    let end = Math.min(start + maxLen, text.length);
    if (end < text.length) {
      const lastBreak = text.lastIndexOf("\n\n", end);
      if (lastBreak > start) end = lastBreak + 2;
    }
    const slice = text.slice(start, end);
    chunks.push({
      chunkId: chunkIdFor(sourceId, idx),
      sourceId,
      index: idx,
      startOffset: start,
      endOffset: end,
      text: slice,
    });
    idx++;
    start = end;
  }
  return chunks;
}

export async function saveChunksForSource(
  vaultPath: string,
  sourceId: string,
  text: string,
  maxChunkChars: number
): Promise<TextChunk[]> {
  const chunks = chunkSourceText(sourceId, text, maxChunkChars);
  const dir = chunksDir(vaultPath);
  await mkdir(dir, { recursive: true });
  const payload: ChunkFile = {
    sourceId,
    maxChunkChars,
    chunks,
    updatedAt: new Date().toISOString(),
  };
  const file = path.join(dir, `${sourceId}.json`);
  await writeFile(file, JSON.stringify(payload, null, 0), "utf-8");
  return chunks;
}

export async function loadChunksForSource(vaultPath: string, sourceId: string): Promise<TextChunk[]> {
  try {
    const file = path.join(chunksDir(vaultPath), `${sourceId}.json`);
    const raw = await readFile(file, "utf-8");
    const data = JSON.parse(raw) as ChunkFile;
    if (!data.chunks || !Array.isArray(data.chunks)) return [];
    return data.chunks;
  } catch {
    return [];
  }
}

export async function loadChunkById(
  vaultPath: string,
  chunkId: string
): Promise<TextChunk | null> {
  const m = /^(.+)-c(\d+)$/.exec(chunkId);
  if (!m) return null;
  const sourceId = m[1]!;
  const chunks = await loadChunksForSource(vaultPath, sourceId);
  return chunks.find((c) => c.chunkId === chunkId) ?? null;
}
