import { createHash } from "crypto";
import { readFile, writeFile, mkdir } from "fs/promises";
import path from "path";

const PROGRESS_DIR = ".vaultmaker";
const SOURCE_INDEX_FILE = "sourceIndex.json";

export interface SourceIndexEntry {
  sourceId: string;
  contentHash: string;
}

export interface SourceIndexData {
  sourceDir: string;
  entries: Record<string, SourceIndexEntry>;
  lastUpdated: string;
}

function getSourceIndexPath(vaultPath: string): string {
  return path.join(vaultPath, PROGRESS_DIR, SOURCE_INDEX_FILE);
}

/** Compute SHA-256 hash of content (string or buffer). */
export function computeContentHash(content: string | Buffer): string {
  const data = typeof content === "string" ? Buffer.from(content, "utf-8") : content;
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Load source index for a vault. Returns null if no index or invalid.
 */
export async function loadSourceIndex(vaultPath: string): Promise<SourceIndexData | null> {
  try {
    const filePath = getSourceIndexPath(vaultPath);
    const raw = await readFile(filePath, "utf-8");
    const data = JSON.parse(raw) as SourceIndexData;
    if (!data || typeof data.sourceDir !== "string" || !data.entries || typeof data.entries !== "object") {
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

/**
 * Save source index for a vault.
 */
export async function saveSourceIndex(vaultPath: string, data: SourceIndexData): Promise<void> {
  const dir = path.join(vaultPath, PROGRESS_DIR);
  await mkdir(dir, { recursive: true });
  const full: SourceIndexData = {
    sourceDir: data.sourceDir,
    entries: data.entries ?? {},
    lastUpdated: data.lastUpdated ?? new Date().toISOString(),
  };
  const filePath = getSourceIndexPath(vaultPath);
  await writeFile(filePath, JSON.stringify(full, null, 0), "utf-8");
}

/**
 * Check if a file needs processing: not in index or hash changed.
 */
export function needsProcessing(
  index: SourceIndexData,
  relPath: string,
  contentHash: string,
  sourceDir: string
): boolean {
  if (index.sourceDir !== sourceDir) return true;
  const entry = index.entries[relPath];
  if (!entry) return true;
  return entry.contentHash !== contentHash;
}
