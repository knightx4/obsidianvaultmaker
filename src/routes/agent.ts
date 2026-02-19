import { Router } from "express";
import { getAgentState, runLoop, requestStop } from "../agent/loop.js";
import { getQueueLength } from "../agent/queue.js";

export const agentRouter = Router();

agentRouter.get("/status", (_req, res) => {
  const state = getAgentState();
  const queueLength = getQueueLength();
  res.json({
    status: state.status,
    currentTask: state.currentTask,
    log: state.log,
    queueLength,
    vaultPath: state.vaultPath,
    vaultName: state.vaultName,
  });
});

agentRouter.post("/start", async (_req, res) => {
  res.json({ ok: true });
  runLoop().catch(() => {});
});

agentRouter.post("/stop", (_req, res) => {
  requestStop();
  res.json({ ok: true });
});
