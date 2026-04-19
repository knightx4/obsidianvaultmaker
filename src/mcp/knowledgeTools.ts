import path from "path";
import { readFile, readdir } from "fs/promises";
import { loadAtomsFile } from "../storage/atomsStore.js";
import { loadSource, getSourcesDir } from "../storage/sources.js";
import { loadChunkById } from "../chunks/chunkSource.js";
import { retrieveRelevantChunkIds } from "../retrieval/chunkEmbeddings.js";
import { getEmbeddingClient } from "../retrieval/retrieve.js";
import { loadAgentConfig } from "../storage/agentConfig.js";
import { buildGraph } from "../graph/buildGraph.js";

export async function getGraphJson(vaultPath: string): Promise<unknown> {
  try {
    const graphPath = path.join(vaultPath, ".vaultmaker", "graph.json");
    const raw = await readFile(graphPath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return { error: "graph.json not found; run the agent or POST /api/knowledge/rebuild-graph" };
  }
}

export async function listAtomsJson(
  vaultPath: string,
  filters: { sourceId?: string; kind?: string }
): Promise<unknown> {
  const f = await loadAtomsFile(vaultPath);
  let atoms = f.atoms;
  if (filters.sourceId) atoms = atoms.filter((a) => a.sourceId === filters.sourceId);
  if (filters.kind) atoms = atoms.filter((a) => a.kind === filters.kind);
  return { schemaVersion: f.schemaVersion, updatedAt: f.updatedAt, atoms };
}

export async function listSourcesJson(vaultPath: string): Promise<unknown> {
  const dir = getSourcesDir(vaultPath);
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch {
    return { sources: [] };
  }
  const sources: Array<{ id: string; path: string; name: string; contentHash?: string }> = [];
  for (const n of names) {
    if (!n.endsWith(".json")) continue;
    const id = n.replace(/\.json$/, "");
    const s = await loadSource(vaultPath, id);
    if (s) {
      sources.push({
        id: s.id,
        path: s.path,
        name: s.name,
        contentHash: s.contentHash,
      });
    }
  }
  return { sources };
}

export async function getChunkJson(vaultPath: string, chunkId: string): Promise<unknown> {
  const chunk = await loadChunkById(vaultPath, chunkId);
  if (!chunk) return { error: "Chunk not found" };
  const source = await loadSource(vaultPath, chunk.sourceId);
  return {
    chunk,
    source: source
      ? { id: source.id, path: source.path, name: source.name, contentHash: source.contentHash }
      : null,
  };
}

export async function retrieveChunksJson(
  vaultPath: string,
  query: string,
  limit: number,
  sourceId?: string,
  useEmbeddings?: boolean
): Promise<unknown> {
  const config = await loadAgentConfig(vaultPath);
  const ue = useEmbeddings ?? config.useEmbeddings;
  const ec = getEmbeddingClient();
  let ranked = await retrieveRelevantChunkIds(vaultPath, query, ec, limit, ue);
  if (sourceId) ranked = ranked.filter((r) => r.sourceId === sourceId);
  const results = await Promise.all(
    ranked.map(async (r) => ({
      ...r,
      chunk: await loadChunkById(vaultPath, r.chunkId),
    }))
  );
  return { results };
}

export async function rebuildGraphJson(vaultPath: string): Promise<unknown> {
  const graph = await buildGraph(vaultPath);
  return { nodeCount: graph.nodes.length, edgeCount: graph.edges.length, graph };
}
