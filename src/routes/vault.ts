import { Router } from "express";
import { access } from "fs/promises";
import path from "path";
import os from "os";
import { setAgentVault, getAgentState } from "../agent/loop.js";

export const vaultRouter = Router();

vaultRouter.post("/config", async (req, res) => {
  const { vaultPath: rawPath, vaultName } = req.body as {
    vaultPath?: string;
    vaultName?: string;
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
  setAgentVault(vaultPath, typeof vaultName === "string" ? vaultName : null);
  res.json({ ok: true, vaultPath, vaultName: vaultName ?? null });
});

vaultRouter.get("/config", (_req, res) => {
  const state = getAgentState();
  res.json({
    vaultPath: state.vaultPath,
    vaultName: state.vaultName,
  });
});
