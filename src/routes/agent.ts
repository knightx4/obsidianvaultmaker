import { Router } from "express";
import path from "path";
import { readdir, stat } from "fs/promises";
import { getAgentState, runLoop, requestStop, isLLMConfigured } from "../agent/loop.js";
import { getQueueLength, getQueueSnapshot } from "../agent/queue.js";
import type { QueuedTask } from "../agent/types.js";
import { loadProgress } from "../storage/progress.js";
import { loadSource } from "../storage/sources.js";
import { subscribeAgentUpdates } from "../agent/events.js";
import { loadSourceIndex } from "../storage/sourceIndex.js";
import { ALLOWED_EXT } from "../lib/fileTypes.js";

export interface SourceTreeNode {
  name: string;
  relPath: string;
  type: "dir" | "file";
  children?: SourceTreeNode[];
  mtime?: string;
  status?: "analyzed" | "queued" | "unsupported" | "pending";
  ext?: string;
}

export const agentRouter = Router();

/** Human-readable label for a queued task for UI display. Resolves sourceId to source path/name when possible. */
async function taskLabel(vaultPath: string | null, t: QueuedTask): Promise<string> {
  if (t.path) return t.path;
  if (t.payload?.sourceId && vaultPath) {
    const source = await loadSource(vaultPath, t.payload.sourceId);
    if (source) return source.path || source.name || t.payload.sourceId;
    return t.payload.sourceId;
  }
  if (t.payload?.sourceId) return t.payload.sourceId;
  if (t.payload?.mocTitle) return t.payload.mocTitle;
  return t.kind;
}

async function buildStatusPayload(): Promise<{
  status: string;
  currentTask: string | null;
  currentStage: string | null;
  log: string[];
  queueLength: number;
  queue: { kind: string; stage: string; label: string }[];
  processedSourceIds: string[];
  processedSourceLabels: string[];
  progressProcessedCount: number;
  progressLastUpdated: string | null;
  vaultPath: string | null;
  vaultName: string | null;
  sourceDir: string | null;
  apiKeyConfigured: boolean;
}> {
  const state = getAgentState();
  const snapshot = getQueueSnapshot();
  const currentStage = state.currentStage;
  const ordered =
    currentStage != null
      ? [
          ...snapshot.filter((t) => t.stage === currentStage),
          ...snapshot.filter((t) => t.stage !== currentStage),
        ]
      : snapshot;
  let progress: Awaited<ReturnType<typeof loadProgress>> = null;
  if (state.vaultPath) {
    progress = await loadProgress(state.vaultPath);
  }
  const queue = await Promise.all(
    ordered.map(async (t) => ({ kind: t.kind, stage: t.stage, label: await taskLabel(state.vaultPath, t) }))
  );
  const processedIds = progress?.processedSourceIds ?? [];
  const processedLabels = await Promise.all(
    processedIds.map(async (id) => {
      const source = state.vaultPath ? await loadSource(state.vaultPath, id) : null;
      return source ? source.path || source.name : id;
    })
  );
  return {
    status: state.status,
    currentTask: state.currentTask,
    currentStage: state.currentStage,
    log: state.log,
    queueLength: getQueueLength(),
    queue,
    processedSourceIds: processedIds,
    processedSourceLabels: processedLabels,
    progressProcessedCount: processedIds.length,
    progressLastUpdated: progress?.lastUpdated ?? null,
    vaultPath: state.vaultPath,
    vaultName: state.vaultName,
    sourceDir: state.sourceDir ?? null,
    apiKeyConfigured: isLLMConfigured(),
  };
}

agentRouter.get("/status", async (_req, res) => {
  const payload = await buildStatusPayload();
  res.json(payload);
});

agentRouter.get("/stream", async (req, res) => {
  req.socket.setTimeout(0);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  const send = (data: object) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const payload = await buildStatusPayload();
  send(payload);

  const unsubscribe = subscribeAgentUpdates(async () => {
    if (res.writableEnded) return;
    try {
      const next = await buildStatusPayload();
      send(next);
    } catch {
      // ignore
    }
  });

  req.on("close", () => {
    unsubscribe();
  });
});

agentRouter.post("/start", async (_req, res) => {
  res.json({ ok: true });
  runLoop().catch(() => {});
});

/** List immediate children of one directory only (lazy loading). Query param: path = relative path from source root (empty = root). */
agentRouter.get("/source-tree", async (req, res) => {
  try {
    const state = getAgentState();
    const sourceDir = state.sourceDir;
    const vaultPath = state.vaultPath;
    if (!vaultPath || !sourceDir) {
      res.status(400).json({
        ok: false,
        error: "No vault or source folder configured",
        path: null,
        children: null,
      });
      return;
    }
    const srcDir: string = sourceDir;
    const vPath: string = vaultPath;
    const dirRel = typeof req.query.path === "string" ? req.query.path : "";

    const snapshot = getQueueSnapshot();
    const queuedSourceIds = new Set(
      snapshot
        .filter((t) => t.payload?.sourceId)
        .map((t) => t.payload!.sourceId as string)
    );
    const progress = await loadProgress(vPath);
    const processedSet = new Set(progress?.processedSourceIds ?? []);
    const index = await loadSourceIndex(vPath);
    const indexEntries = index?.sourceDir === srcDir ? index.entries : {};

    const fullDir = path.join(srcDir, dirRel);
    let entries: { name: string; isDirectory: () => boolean }[];
    try {
      entries = await readdir(fullDir, { withFileTypes: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.json({
        ok: false,
        error: "Could not read folder: " + message,
        path: dirRel,
        children: null,
      });
      return;
    }
    const nodes: SourceTreeNode[] = [];
    for (const e of entries) {
      const rel = path.normalize(dirRel ? `${dirRel}/${e.name}` : e.name).replace(/\\/g, "/");
      if (e.isDirectory()) {
        nodes.push({
          name: e.name,
          relPath: rel,
          type: "dir",
          children: [], // lazy: load on expand
        });
      } else {
        const ext = path.extname(e.name).toLowerCase();
        const supported = ALLOWED_EXT.includes(ext);
        const entry = indexEntries[rel];
        const sourceId = entry?.sourceId;
        const analyzed = sourceId != null && processedSet.has(sourceId);
        const queued = sourceId != null && queuedSourceIds.has(sourceId);
        let status: SourceTreeNode["status"];
        if (!supported) status = "unsupported";
        else if (analyzed) status = "analyzed";
        else if (queued) status = "queued";
        else status = "pending";

        let mtime: string | undefined;
        try {
          const st = await stat(path.join(srcDir, rel));
          if (st.mtime) mtime = st.mtime.toISOString();
        } catch {
          // leave mtime unset
        }
        nodes.push({
          name: e.name,
          relPath: rel,
          type: "file",
          mtime,
          status,
          ext: ext || undefined,
        });
      }
    }
    nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    });
    res.json({ ok: true, sourceDir: srcDir, path: dirRel, children: nodes });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({
      ok: false,
      error: "Source tree error: " + message,
      path: null,
      children: null,
    });
  }
});

agentRouter.post("/stop", (_req, res) => {
  requestStop();
  res.json({ ok: true });
});
