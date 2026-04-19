import { readFile, writeFile, mkdir } from "fs/promises";
import path from "path";
import type { EvidenceRef, AtomKind } from "../agent/atomTypes.js";

const VAULTMAKER_DIR = ".vaultmaker";
const ATOMS_FILE = "atoms.json";

export interface AtomRecord {
  atomId: string;
  kind: AtomKind;
  title: string;
  type?: string;
  path: string;
  sourceId?: string;
  source?: string;
  chunkIds: string[];
  evidenceRefs: EvidenceRef[];
  provenance: "extracted" | "inferred" | "validated";
  extractedAt?: string;
  pipelineVersion?: string;
}

export interface SourceRef {
  id: string;
  path: string;
  name: string;
}

export interface ChunkRef {
  chunkId: string;
  sourceId: string;
  startOffset: number;
  endOffset: number;
}

export interface AtomEdgeRecord {
  id: string;
  fromAtomId: string;
  toAtomId: string;
  relation: string;
  provenance: "inline" | "inferred";
}

export interface AtomsFile {
  schemaVersion: number;
  updatedAt: string;
  sources: SourceRef[];
  chunks: ChunkRef[];
  atoms: AtomRecord[];
  edges: AtomEdgeRecord[];
}

const EMPTY: AtomsFile = {
  schemaVersion: 1,
  updatedAt: new Date().toISOString(),
  sources: [],
  chunks: [],
  atoms: [],
  edges: [],
};

function getPath(vaultPath: string): string {
  return path.join(vaultPath, VAULTMAKER_DIR, ATOMS_FILE);
}

export async function loadAtomsFile(vaultPath: string): Promise<AtomsFile> {
  try {
    const raw = await readFile(getPath(vaultPath), "utf-8");
    const data = JSON.parse(raw) as Partial<AtomsFile>;
    if (!data || typeof data !== "object") return { ...EMPTY, updatedAt: new Date().toISOString() };
    return {
      schemaVersion: typeof data.schemaVersion === "number" ? data.schemaVersion : 1,
      updatedAt: typeof data.updatedAt === "string" ? data.updatedAt : new Date().toISOString(),
      sources: Array.isArray(data.sources) ? data.sources : [],
      chunks: Array.isArray(data.chunks) ? data.chunks : [],
      atoms: Array.isArray(data.atoms) ? data.atoms : [],
      edges: Array.isArray(data.edges) ? data.edges : [],
    };
  } catch {
    return { ...EMPTY, updatedAt: new Date().toISOString() };
  }
}

export async function saveAtomsFile(vaultPath: string, file: AtomsFile): Promise<void> {
  const dir = path.join(vaultPath, VAULTMAKER_DIR);
  await mkdir(dir, { recursive: true });
  const out: AtomsFile = {
    ...file,
    updatedAt: new Date().toISOString(),
  };
  await writeFile(getPath(vaultPath), JSON.stringify(out, null, 2), "utf-8");
}

export async function upsertAtom(vaultPath: string, atom: AtomRecord): Promise<void> {
  const f = await loadAtomsFile(vaultPath);
  const idx = f.atoms.findIndex((a) => a.atomId === atom.atomId);
  if (idx >= 0) f.atoms[idx] = atom;
  else f.atoms.push(atom);
  await saveAtomsFile(vaultPath, f);
}

export async function upsertAtomsBatch(vaultPath: string, atoms: AtomRecord[]): Promise<void> {
  const f = await loadAtomsFile(vaultPath);
  for (const atom of atoms) {
    const idx = f.atoms.findIndex((a) => a.atomId === atom.atomId);
    if (idx >= 0) f.atoms[idx] = atom;
    else f.atoms.push(atom);
  }
  await saveAtomsFile(vaultPath, f);
}

export async function mergeSourcesAndChunks(
  vaultPath: string,
  sources: SourceRef[],
  chunks: ChunkRef[]
): Promise<void> {
  const f = await loadAtomsFile(vaultPath);
  const sourceById = new Map(f.sources.map((s) => [s.id, s]));
  for (const s of sources) sourceById.set(s.id, s);
  f.sources = [...sourceById.values()];

  const chunkById = new Map(f.chunks.map((c) => [c.chunkId, c]));
  for (const c of chunks) chunkById.set(c.chunkId, c);
  f.chunks = [...chunkById.values()];

  await saveAtomsFile(vaultPath, f);
}

export async function upsertEdges(vaultPath: string, edges: AtomEdgeRecord[]): Promise<void> {
  const f = await loadAtomsFile(vaultPath);
  const byId = new Map(f.edges.map((e) => [e.id, e]));
  for (const e of edges) byId.set(e.id, e);
  f.edges = [...byId.values()];
  await saveAtomsFile(vaultPath, f);
}
