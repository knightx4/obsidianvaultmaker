import { mkdir, writeFile, readFile } from "fs/promises";
import path from "path";

const VAULTMAKER_DIR = ".vaultmaker";
const DRAFTS_SUBDIR = "drafts";

export interface DraftPayload {
  runId: string;
  updatedAt: string;
  atoms: unknown[];
  graph?: unknown;
  notes?: string[];
}

function draftPath(vaultPath: string, runId: string): string {
  return path.join(vaultPath, VAULTMAKER_DIR, DRAFTS_SUBDIR, `${runId}.json`);
}

export async function appendDraftAtoms(vaultPath: string, runId: string, atoms: unknown[]): Promise<void> {
  if (atoms.length === 0) return;
  const p = draftPath(vaultPath, runId);
  let existing: DraftPayload = {
    runId,
    updatedAt: new Date().toISOString(),
    atoms: [],
  };
  try {
    const raw = await readFile(p, "utf-8");
    existing = { ...existing, ...JSON.parse(raw) };
    if (!Array.isArray(existing.atoms)) existing.atoms = [];
  } catch {
    // new draft
  }
  existing.atoms = [...existing.atoms, ...atoms];
  existing.updatedAt = new Date().toISOString();
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(existing, null, 2), "utf-8");
}
