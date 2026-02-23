import { readFile, writeFile, mkdir } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface StagedSource {
  id: string;
  path: string;
  name: string;
  text: string;
}

function getStagingDir(): string {
  return path.resolve(__dirname, "..", "..", "data", "sources");
}

export function getStagingPath(): string {
  return getStagingDir();
}

export function generateSourceId(): string {
  return randomUUID().slice(0, 12);
}

export async function saveSource(id: string, data: Omit<StagedSource, "id">): Promise<void> {
  const dir = getStagingDir();
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${id}.json`);
  await writeFile(file, JSON.stringify({ id, ...data }, null, 0), "utf-8");
}

export async function loadSource(id: string): Promise<StagedSource | null> {
  try {
    const file = path.join(getStagingDir(), `${id}.json`);
    const raw = await readFile(file, "utf-8");
    return JSON.parse(raw) as StagedSource;
  } catch {
    return null;
  }
}
