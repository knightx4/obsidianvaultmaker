import { Router } from "express";
import path from "path";
import { readdir, readFile } from "fs/promises";
import { getAgentState, setSourceDir } from "../agent/loop.js";
import { enqueueSourceForProcessing } from "../agent/loop.js";
import { isExtractable, extractText } from "../extract/office.js";
import { pickFolder } from "../lib/folderPicker.js";
import { saveSource, generateSourceId } from "../storage/sources.js";
import {
  loadSourceIndex,
  saveSourceIndex,
  computeContentHash,
  needsProcessing,
} from "../storage/sourceIndex.js";
import { saveVaultConfig } from "../storage/vaultConfig.js";
import { startSourceWatcher } from "../watcher/sourceWatcher.js";
import { ALLOWED_EXT } from "../lib/fileTypes.js";

export const uploadRouter = Router();

/**
 * Walk sourceDir and stage each allowed file (extract text → save to staging → enqueue extract-insights).
 * Skips files that haven't changed (content hash match). Starts watcher for future changes.
 * Exported so vault config save can trigger initial scan.
 */
export async function importFolderInBackground(sourceDir: string): Promise<void> {
  const state = getAgentState();
  const vaultPath = state.vaultPath;
  if (!vaultPath) return;
  const vPath: string = vaultPath;

  let index = await loadSourceIndex(vPath);
  if (!index || index.sourceDir !== sourceDir) {
    index = { sourceDir, entries: {}, lastUpdated: new Date().toISOString() };
  }

  let enqueuedCount = 0;

  async function walkAndProcess(dir: string): Promise<void> {
    const fullDir = path.join(sourceDir, dir);
    const entries = await readdir(fullDir, { withFileTypes: true });
    for (const e of entries) {
      const rel = path.normalize(dir ? `${dir}/${e.name}` : e.name).replace(/\\/g, "/");
      if (e.isDirectory()) {
        await walkAndProcess(rel);
      } else if (ALLOWED_EXT.includes(path.extname(e.name).toLowerCase())) {
        const ext = path.extname(rel).toLowerCase();
        const fullSource = path.join(sourceDir, rel);
        try {
          let text: string;
          let buffer: Buffer;
          if (isExtractable(ext)) {
            buffer = await readFile(fullSource);
            text = (await extractText(buffer)) || "(No text extracted.)";
          } else {
            text = await readFile(fullSource, "utf-8");
            buffer = Buffer.from(text, "utf-8");
          }
          const contentHash = computeContentHash(text);
          if (!needsProcessing(index!, rel, contentHash, sourceDir)) continue;

          const id = generateSourceId();
          const name = path.basename(rel, ext) || rel;
          await saveSource(vPath, id, { path: rel, name, text });
          enqueueSourceForProcessing(id);
          index!.entries[rel] = { sourceId: id, contentHash };
          enqueuedCount++;
        } catch {
          // skip unreadable files
        }
      }
    }
  }

  await walkAndProcess("");
  index!.lastUpdated = new Date().toISOString();
  await saveSourceIndex(vPath, index!);
  setSourceDir(sourceDir);
  await saveVaultConfig({ vaultPath: vPath, sourceDir });
  startSourceWatcher(sourceDir, vPath);
}

uploadRouter.post("/import-folder", async (req, res) => {
  const state = getAgentState();
  if (!state.vaultPath) {
    res.status(400).json({ ok: false, error: "Set vault path first" });
    return;
  }
  const pickResult = pickFolder("Choose folder to import from");
  if ("cancelled" in pickResult) {
    res.json({ ok: true, cancelled: true, started: false });
    return;
  }
  if ("error" in pickResult) {
    res.status(500).json({ ok: false, error: pickResult.error });
    return;
  }
  const sourceDir = pickResult.path;
  res.json({ ok: true, started: true, sourceDir, message: "Import started. Sources are being staged in the background; new or changed files will be queued. The source folder is now being watched for changes." });
  void importFolderInBackground(sourceDir);
});
