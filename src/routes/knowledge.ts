import { Router } from "express";
import path from "path";
import { readFile, readdir } from "fs/promises";
import { getAgentState } from "../agent/loop.js";
import { loadAtomsFile } from "../storage/atomsStore.js";
import { loadSource, getSourcesDir } from "../storage/sources.js";
import { loadChunkById } from "../chunks/chunkSource.js";
import { retrieveRelevantChunkIds } from "../retrieval/chunkEmbeddings.js";
import { getEmbeddingClient } from "../retrieval/retrieve.js";
import { loadAgentConfig } from "../storage/agentConfig.js";
import { buildGraph } from "../graph/buildGraph.js";

export const knowledgeRouter = Router();

knowledgeRouter.get("/graph", async (_req, res) => {
  try {
    const state = getAgentState();
    if (!state.vaultPath) {
      res.status(400).json({ ok: false, error: "No vault configured" });
      return;
    }
    const graphPath = path.join(state.vaultPath, ".vaultmaker", "graph.json");
    const raw = await readFile(graphPath, "utf-8");
    res.json({ ok: true, graph: JSON.parse(raw) });
  } catch (err) {
    res.status(404).json({ ok: false, error: (err as Error).message });
  }
});

knowledgeRouter.get("/atoms", async (req, res) => {
  try {
    const state = getAgentState();
    if (!state.vaultPath) {
      res.status(400).json({ ok: false, error: "No vault configured" });
      return;
    }
    const sourceId = typeof req.query.sourceId === "string" ? req.query.sourceId : undefined;
    const kind = typeof req.query.kind === "string" ? req.query.kind : undefined;
    const f = await loadAtomsFile(state.vaultPath);
    let atoms = f.atoms;
    if (sourceId) atoms = atoms.filter((a) => a.sourceId === sourceId);
    if (kind) atoms = atoms.filter((a) => a.kind === kind);
    res.json({ ok: true, atoms, schemaVersion: f.schemaVersion, updatedAt: f.updatedAt });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

knowledgeRouter.get("/sources", async (_req, res) => {
  try {
    const state = getAgentState();
    if (!state.vaultPath) {
      res.status(400).json({ ok: false, error: "No vault configured" });
      return;
    }
    const dir = getSourcesDir(state.vaultPath);
    let names: string[] = [];
    try {
      names = await readdir(dir);
    } catch {
      res.json({ ok: true, sources: [] });
      return;
    }
    const sources: Array<{ id: string; path: string; name: string; contentHash?: string }> = [];
    for (const n of names) {
      if (!n.endsWith(".json")) continue;
      const id = n.replace(/\.json$/, "");
      const s = await loadSource(state.vaultPath, id);
      if (s) {
        sources.push({
          id: s.id,
          path: s.path,
          name: s.name,
          contentHash: s.contentHash,
        });
      }
    }
    res.json({ ok: true, sources });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

knowledgeRouter.get("/chunks/:chunkId", async (req, res) => {
  try {
    const state = getAgentState();
    if (!state.vaultPath) {
      res.status(400).json({ ok: false, error: "No vault configured" });
      return;
    }
    const chunk = await loadChunkById(state.vaultPath, req.params.chunkId);
    if (!chunk) {
      res.status(404).json({ ok: false, error: "Chunk not found" });
      return;
    }
    const source = await loadSource(state.vaultPath, chunk.sourceId);
    res.json({
      ok: true,
      chunk,
      source: source
        ? { id: source.id, path: source.path, name: source.name, contentHash: source.contentHash }
        : null,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

knowledgeRouter.post("/retrieve", async (req, res) => {
  try {
    const state = getAgentState();
    const vaultPath = state.vaultPath;
    if (!vaultPath) {
      res.status(400).json({ ok: false, error: "No vault configured" });
      return;
    }
    const body = req.body as {
      query?: string;
      limit?: number;
      sourceId?: string;
      useEmbeddings?: boolean;
    };
    const query = typeof body.query === "string" ? body.query : "";
    const limit = typeof body.limit === "number" ? body.limit : 10;
    const config = await loadAgentConfig(vaultPath);
    const useEmbeddings = body.useEmbeddings ?? config.useEmbeddings;
    const ec = getEmbeddingClient();
    let ranked = await retrieveRelevantChunkIds(vaultPath, query, ec, limit, useEmbeddings);
    if (body.sourceId) {
      ranked = ranked.filter((r) => r.sourceId === body.sourceId);
    }
    const chunks = await Promise.all(
      ranked.map(async (r) => {
        const ch = await loadChunkById(vaultPath, r.chunkId);
        return { ...r, chunk: ch };
      })
    );
    res.json({ ok: true, results: chunks });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

knowledgeRouter.post("/rebuild-graph", async (_req, res) => {
  try {
    const state = getAgentState();
    if (!state.vaultPath) {
      res.status(400).json({ ok: false, error: "No vault configured" });
      return;
    }
    const graph = await buildGraph(state.vaultPath);
    res.json({ ok: true, nodeCount: graph.nodes.length, edgeCount: graph.edges.length });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});
