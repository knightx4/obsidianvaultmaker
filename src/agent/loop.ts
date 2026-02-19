import path from "path";
import type { LLMClient } from "../llm/client.js";
import type { AgentState, QueuedTask } from "./types.js";
import {
  dequeue,
  getQueueLength,
  appendLog,
  getLog,
  enqueue,
} from "./queue.js";
import { trySplitNote, readNote } from "./split.js";
import {
  addLinksToNote,
  listMarkdownFiles,
  extractNoteTitlesFromVault,
} from "./link.js";

let state: AgentState = {
  status: "idle",
  currentTask: null,
  log: [],
  vaultPath: null,
  vaultName: null,
};

let stopRequested = false;
let llm: LLMClient | null = null;

export function getAgentState(): AgentState {
  return {
    ...state,
    log: getLog(),
  };
}

export function setAgentVault(vaultPath: string | null, vaultName: string | null): void {
  state.vaultPath = vaultPath;
  state.vaultName = vaultName;
}

export function setLLM(client: LLMClient): void {
  llm = client;
}

export function requestStop(): void {
  stopRequested = true;
}

function setStatus(status: AgentState["status"], currentTask: string | null): void {
  state.status = status;
  state.currentTask = currentTask;
}

export async function runLoop(): Promise<void> {
  if (state.vaultPath == null || llm == null) {
    appendLog("Cannot start: set vault path and ensure OPENAI_API_KEY is set.");
    return;
  }
  if (state.status === "processing") {
    appendLog("Agent is already running.");
    return;
  }

  stopRequested = false;
  setStatus("processing", null);

  const vaultPath = state.vaultPath;

  try {
    while (!stopRequested) {
      const task = dequeue();
      if (!task) {
        appendLog("Queue empty. Idle.");
        setStatus("idle", null);
        return;
      }

      setStatus("processing", `${task.kind}: ${task.path}`);

      if (task.kind === "split") {
        try {
          const content = await readNote(vaultPath, task.path);
          const result = await trySplitNote(llm, vaultPath, task.path, content);
          for (const rel of result.createdPaths ?? []) {
            enqueue({ kind: "link", path: rel });
          }
          const remaining = getQueueLength();
          if (remaining > 0) appendLog(`${remaining} tasks left in queue.`);
        } catch (err) {
          appendLog(`Error splitting ${task.path}: ${(err as Error).message}`);
        }
      } else if (task.kind === "link") {
        try {
          const content = await readNote(vaultPath, task.path);
          const allMd = await listMarkdownFiles(vaultPath);
          const norm = (p: string) => p.split(path.sep).join("/");
          const others = extractNoteTitlesFromVault(
            allMd.filter((p) => norm(p) !== norm(task.path))
          );
          await addLinksToNote(llm, vaultPath, task.path, content, others);
        } catch (err) {
          appendLog(`Error linking ${task.path}: ${(err as Error).message}`);
        }
      }
    }
    setStatus("idle", null);
    appendLog("Stopped by user.");
  } catch (err) {
    appendLog(`Agent error: ${(err as Error).message}`);
    setStatus("idle", null);
  }
}

export function enqueueFileForProcessing(relativePath: string): void {
  enqueue({ kind: "split", path: relativePath });
  enqueue({ kind: "link", path: relativePath });
}
