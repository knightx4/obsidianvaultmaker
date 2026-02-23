import path from "path";
import chokidar, { type FSWatcher } from "chokidar";
import { readFile } from "fs/promises";
import {
  loadSourceIndex,
  saveSourceIndex,
  computeContentHash,
  needsProcessing,
  type SourceIndexData,
} from "../storage/sourceIndex.js";
import { saveSource, generateSourceId } from "../storage/sources.js";
import { enqueueSourceForProcessing } from "../agent/loop.js";
import { isExtractable, extractText } from "../extract/office.js";
import { appendLog } from "../agent/queue.js";

const ALLOWED_EXT = [".md", ".txt", ".pdf", ".docx", ".doc", ".pptx", ".ppt"];

let watcher: FSWatcher | null = null;

function normalizeRel(sourceDir: string, fullPath: string): string {
  const rel = path.relative(sourceDir, fullPath);
  return rel.split(path.sep).join("/");
}

async function processFile(
  fullPath: string,
  sourceDir: string,
  vaultPath: string
): Promise<{ enqueued: boolean }> {
  const ext = path.extname(fullPath).toLowerCase();
  if (!ALLOWED_EXT.includes(ext)) return { enqueued: false };
  const rel = normalizeRel(sourceDir, fullPath);

  let text: string;
  let buffer: Buffer;
  try {
    buffer = await readFile(fullPath);
    if (isExtractable(ext)) {
      text = (await extractText(buffer)) || "(No text extracted.)";
    } else {
      text = buffer.toString("utf-8");
    }
  } catch {
    return { enqueued: false };
  }

  const contentHash = computeContentHash(text);
  let index = await loadSourceIndex(vaultPath);
  if (!index || index.sourceDir !== sourceDir) {
    index = { sourceDir, entries: {}, lastUpdated: new Date().toISOString() };
  }

  if (!needsProcessing(index, rel, contentHash, sourceDir)) {
    return { enqueued: false };
  }

  const id = generateSourceId();
  const name = path.basename(rel, ext) || rel;
  await saveSource(vaultPath, id, { path: rel, name, text });
  enqueueSourceForProcessing(id);

  index.entries[rel] = { sourceId: id, contentHash };
  index.lastUpdated = new Date().toISOString();
  await saveSourceIndex(vaultPath, index);

  appendLog(`Source changed: ${rel} → queued for re-processing`);
  return { enqueued: true };
}

export function startSourceWatcher(sourceDir: string, vaultPath: string): void {
  stopSourceWatcher();
  watcher = chokidar.watch(sourceDir, {
    ignored: /(^|[\/\\])\../,
    persistent: true,
    ignoreInitial: true,
  });

  watcher.on("add", (fullPath: string) => {
    void processFile(fullPath, sourceDir, vaultPath);
  });

  watcher.on("change", (fullPath: string) => {
    void processFile(fullPath, sourceDir, vaultPath);
  });

  appendLog(`Watching source folder: ${sourceDir}`);
}

export function stopSourceWatcher(): void {
  if (watcher) {
    watcher.close();
    watcher = null;
    appendLog("Stopped watching source folder");
  }
}
