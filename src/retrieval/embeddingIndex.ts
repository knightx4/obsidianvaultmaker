import { readFile, writeFile, mkdir } from "fs/promises";
import path from "path";

const INDEX_DIR_NAME = ".vaultmaker";
const INDEX_FILE = "embeddingIndex.json";

export interface IndexEntry {
  title: string;
  path: string;
  embedding?: number[];
  textSnippet: string;
}

export interface EmbeddingIndex {
  entries: IndexEntry[];
  updatedAt: string;
}

function getIndexPath(vaultPath: string): string {
  return path.join(vaultPath, INDEX_DIR_NAME, INDEX_FILE);
}

export async function loadIndex(vaultPath: string): Promise<EmbeddingIndex> {
  try {
    const filePath = getIndexPath(vaultPath);
    const raw = await readFile(filePath, "utf-8");
    const data = JSON.parse(raw) as EmbeddingIndex;
    if (!data || !Array.isArray(data.entries)) return { entries: [], updatedAt: new Date().toISOString() };
    data.entries = data.entries.filter(
      (e) => e && typeof e.title === "string" && typeof e.path === "string" && typeof e.textSnippet === "string"
    );
    return {
      entries: data.entries,
      updatedAt: typeof data.updatedAt === "string" ? data.updatedAt : new Date().toISOString(),
    };
  } catch {
    return { entries: [], updatedAt: new Date().toISOString() };
  }
}

export async function saveIndex(vaultPath: string, index: EmbeddingIndex): Promise<void> {
  const dir = path.join(vaultPath, INDEX_DIR_NAME);
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, INDEX_FILE);
  const toSave: EmbeddingIndex = {
    entries: index.entries,
    updatedAt: new Date().toISOString(),
  };
  await writeFile(filePath, JSON.stringify(toSave, null, 0), "utf-8");
}

/**
 * Upsert a note into the index by title. Replaces existing entry with same title.
 */
export async function indexNote(
  vaultPath: string,
  title: string,
  relativePath: string,
  textSnippet: string,
  embedding?: number[]
): Promise<void> {
  const index = await loadIndex(vaultPath);
  const entry: IndexEntry = { title, path: relativePath, textSnippet, embedding };
  const existing = index.entries.findIndex((e) => e.title === title);
  if (existing >= 0) index.entries[existing] = entry;
  else index.entries.push(entry);
  await saveIndex(vaultPath, index);
}

/**
 * Remove a note from the index by title.
 */
export async function removeFromIndex(vaultPath: string, title: string): Promise<void> {
  const index = await loadIndex(vaultPath);
  index.entries = index.entries.filter((e) => e.title !== title);
  await saveIndex(vaultPath, index);
}
