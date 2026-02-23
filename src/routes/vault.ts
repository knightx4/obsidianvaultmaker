import { Router } from "express";
import { access } from "fs/promises";
import path from "path";
import os from "os";
import { setAgentVault, getAgentState, setSourceDir } from "../agent/loop.js";
import { pickFolder } from "../lib/folderPicker.js";
import { saveVaultConfig } from "../storage/vaultConfig.js";
import { startSourceWatcher, stopSourceWatcher } from "../watcher/sourceWatcher.js";
import { importFolderInBackground } from "./upload.js";

export const vaultRouter = Router();

vaultRouter.get("/pick-folder", (_req, res) => {
  const result = pickFolder();
  if ("path" in result) res.json({ ok: true, path: result.path });
  else if ("cancelled" in result) res.json({ ok: true, cancelled: true });
  else res.status(500).json({ ok: false, error: result.error });
});

vaultRouter.post("/config", async (req, res) => {
  const { vaultPath: rawPath, vaultName, sourceDir: rawSourceDir } = req.body as {
    vaultPath?: string;
    vaultName?: string;
    sourceDir?: string;
  };
  if (!rawPath || typeof rawPath !== "string") {
    res.status(400).json({ ok: false, error: "vaultPath required" });
    return;
  }
  const vaultPath = path.resolve(rawPath.replace(/^~/, os.homedir()));
  try {
    await access(vaultPath);
  } catch {
    res.status(400).json({ ok: false, error: "Path does not exist or is not accessible" });
    return;
  }
  const sourceDir =
    typeof rawSourceDir === "string" && rawSourceDir.trim()
      ? path.resolve(rawSourceDir.replace(/^~/, os.homedir()))
      : null;

  await setAgentVault(vaultPath, typeof vaultName === "string" ? vaultName : null);
  setSourceDir(sourceDir);
  await saveVaultConfig({ vaultPath, vaultName: vaultName ?? null, sourceDir });

  stopSourceWatcher();
  if (sourceDir) {
    try {
      await access(sourceDir);
      startSourceWatcher(sourceDir, vaultPath);
      void importFolderInBackground(sourceDir);
    } catch {
      // source folder not accessible, skip watcher
    }
  }

  res.json({ ok: true, vaultPath, vaultName: vaultName ?? null, sourceDir });
});

vaultRouter.get("/config", (_req, res) => {
  const state = getAgentState();
  res.json({
    vaultPath: state.vaultPath,
    vaultName: state.vaultName,
    sourceDir: state.sourceDir,
  });
});
