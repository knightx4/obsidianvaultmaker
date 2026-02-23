import { readFile, writeFile, mkdir } from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";

const VAULTMAKER_DIR = ".vaultmaker";
const SOURCES_SUBDIR = "sources";

export interface StagedSource {
  id: string;
  path: string;
  name: string;
  text: string;
}

/** Directory where staged source files are stored for a vault (inside the vault folder). */
export function getSourcesDir(vaultPath: string): string {
  return path.join(vaultPath, VAULTMAKER_DIR, SOURCES_SUBDIR);
}

/** @deprecated Use getSourcesDir(vaultPath). Kept for compatibility. */
export function getStagingPath(vaultPath: string): string {
  return getSourcesDir(vaultPath);
}

export function generateSourceId(): string {
  return randomUUID().slice(0, 12);
}

export async function saveSource(
  vaultPath: string,
  id: string,
  data: Omit<StagedSource, "id">
): Promise<void> {
  const dir = getSourcesDir(vaultPath);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${id}.json`);
  await writeFile(file, JSON.stringify({ id, ...data }, null, 0), "utf-8");
}

export async function loadSource(vaultPath: string, id: string): Promise<StagedSource | null> {
  try {
    const file = path.join(getSourcesDir(vaultPath), `${id}.json`);
    const raw = await readFile(file, "utf-8");
    return JSON.parse(raw) as StagedSource;
  } catch {
    return null;
  }
}
