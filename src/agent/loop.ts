import path from "path";
import type { LLMClient } from "../llm/client.js";
import type { AgentState, QueuedTask, Stage } from "./types.js";
import { STAGES } from "./types.js";
import {
  dequeueForStage,
  getQueueLength,
  getQueueSnapshot,
  appendLog,
  getLog,
  enqueue,
  enqueueMany,
  clearQueue,
} from "./queue.js";
import { notifyAgentUpdate } from "./events.js";
import { loadProgress, saveProgress, restoreFromProgress } from "../storage/progress.js";
import { clearSourceIndex } from "../storage/sourceIndex.js";
import {
  readNote,
  addLinksToNote,
  listMarkdownFiles,
  extractNoteTitlesFromVault,
} from "./link.js";
import { extractInsightsFromSource, getExistingInsightTitles } from "./insights.js";
import { loadAgentConfig } from "../storage/agentConfig.js";
import { getRelevantTitles } from "../retrieval/retrieve.js";
import { getEmbeddingClient } from "../retrieval/retrieve.js";
import { indexNote } from "../retrieval/embeddingIndex.js";
import { runOrganizeVault, getMocList } from "./organize.js";
import { runDeduceForNote } from "./deduce.js";
import { runInduceForMoc } from "./induce.js";
import { runValidation } from "./validate.js";
import { loadSource } from "../storage/sources.js";

let state: AgentState = {
  status: "idle",
  currentTask: null,
  currentStage: null,
  log: [],
  vaultPath: null,
  vaultName: null,
  sourceDir: null,
};

let stopRequested = false;
let llm: LLMClient | null = null;

export function getAgentState(): AgentState {
  return {
    ...state,
    log: getLog(),
  };
}

export async function setAgentVault(vaultPath: string | null, vaultName: string | null): Promise<void> {
  state.vaultPath = vaultPath;
  state.vaultName = vaultName;
  if (vaultPath) {
    const result = await restoreFromProgress(vaultPath, getQueueLength());
    const progress = await loadProgress(vaultPath);
    if (result.restored && result.queueLength > 0) {
      state.currentStage = result.currentStage ?? STAGES[0];
      appendLog(`Progress restored: ${result.queueLength} task(s) in queue, ${result.processedCount} source(s) already analyzed.`);
    } else if (progress) {
      state.currentStage = progress.currentStage ?? STAGES[0];
    } else {
      state.currentStage = STAGES[0];
    }
  } else {
    state.currentStage = null;
    state.sourceDir = null;
  }
}

export function setSourceDir(sourceDir: string | null): void {
  state.sourceDir = sourceDir;
}

export function getSourceDir(): string | null {
  return state.sourceDir;
}

/** Clear the task queue and set stage to extract. Call when vault or source folder changes so the next import populates the queue fresh. */
export function resetQueueForNewSource(): void {
  clearQueue();
  state.currentStage = "extract";
  notifyAgentUpdate();
}

/**
 * Reset the current vault to a fresh state: clear queue, clear progress and source index on disk, clear current vault from state.
 * Use when the user wants to "start a new vault" (re-run from scratch). UI will show "Create vault to start agent" until they create a vault again.
 */
export async function resetVaultToNew(vaultPath: string): Promise<void> {
  clearQueue();
  await saveProgress(vaultPath, {
    processedSourceIds: [],
    queue: [],
    currentStage: null,
  });
  await clearSourceIndex(vaultPath);
  state.vaultPath = null;
  state.vaultName = null;
  state.sourceDir = null;
  state.currentStage = null;
  appendLog("Vault reset. Create vault to start agent.");
  notifyAgentUpdate();
}

export function setLLM(client: LLMClient): void {
  llm = client;
}

export function isLLMConfigured(): boolean {
  return llm != null;
}

export function requestStop(): void {
  stopRequested = true;
  if (state.status === "processing") {
    setStatus("stopping", "Stopping after current task…");
  }
}

function setStatus(status: AgentState["status"], currentTask: string | null): void {
  state.status = status;
  state.currentTask = currentTask;
  notifyAgentUpdate();
}

async function enqueueWorkForStage(stage: Stage, vaultPath: string): Promise<void> {
  if (stage === "organize") {
    enqueue({ kind: "organize-vault", stage: "organize" });
  } else if (stage === "connect") {
    const files = await listMarkdownFiles(vaultPath);
    const tasks: QueuedTask[] = files.map((rel) => ({ kind: "link", stage: "connect", path: rel }));
    enqueueMany(tasks);
  } else if (stage === "deduce") {
    const files = await listMarkdownFiles(vaultPath);
    const mocPrefix = "MOCs/";
    const insightFiles = files.filter(
      (f) => !f.startsWith(mocPrefix) && f.endsWith(".md")
    );
    const tasks: QueuedTask[] = insightFiles.map((relPath) => ({
      kind: "deduce",
      stage: "deduce",
      path: relPath,
    }));
    enqueueMany(tasks);
  } else if (stage === "induce") {
    const mocList = await getMocList(vaultPath);
    const tasks: QueuedTask[] = mocList.map((m) => ({
      kind: "induce",
      stage: "induce",
      payload: {
        mocPath: m.mocPath,
        mocTitle: m.mocTitle,
        noteTitles: m.noteTitles,
        mocSummary: m.mocSummary,
      },
    }));
    enqueueMany(tasks);
  } else if (stage === "organize-again") {
    enqueue({ kind: "organize-moc", stage: "organize-again" });
  } else if (stage === "validate") {
    enqueue({ kind: "validate", stage: "validate" });
  }
}

async function persistProgress(vaultPath: string, completedSourceId?: string): Promise<void> {
  try {
    const loaded = await loadProgress(vaultPath);
    const processedSourceIds = [...(loaded?.processedSourceIds ?? [])];
    if (completedSourceId) processedSourceIds.push(completedSourceId);
    await saveProgress(vaultPath, {
      processedSourceIds,
      currentStage: state.currentStage,
      queue: getQueueSnapshot(),
    });
    notifyAgentUpdate();
  } catch {
    // non-fatal
  }
}

export async function runLoop(): Promise<void> {
  if (state.vaultPath == null) {
    appendLog("Cannot start: set the vault path in the Vault section and click Save config.");
    return;
  }
  if (llm == null) {
    appendLog("Cannot start: add OPENAI_API_KEY to the .env file in the app folder and restart the server.");
    return;
  }
  if (state.status === "processing") {
    appendLog("Agent is already running.");
    return;
  }

  stopRequested = false;
  state.currentStage = STAGES[0];
  setStatus("processing", null);

  const vaultPath = state.vaultPath;

  try {
    while (!stopRequested) {
      const currentStage = state.currentStage!;
      let task = dequeueForStage(currentStage);

      if (!task) {
        if (getQueueLength() === 0) {
          const idx = STAGES.indexOf(currentStage);
          if (idx >= 0 && idx < STAGES.length - 1) {
            state.currentStage = STAGES[idx + 1];
            appendLog(`Stage complete: ${currentStage} → ${STAGES[idx + 1]}`);
            await enqueueWorkForStage(STAGES[idx + 1], vaultPath);
            await persistProgress(vaultPath);
            continue;
          }
          appendLog("Queue empty. Idle.");
          state.currentStage = null;
          setStatus("idle", null);
          await persistProgress(vaultPath);
          return;
        }
        const idx = STAGES.indexOf(currentStage);
        if (idx < 0 || idx === STAGES.length - 1) {
          state.currentStage = null;
          setStatus("idle", null);
          await persistProgress(vaultPath);
          return;
        }
        const nextStage = STAGES[idx + 1];
        state.currentStage = nextStage;
        appendLog(`Stage complete: ${currentStage} → ${nextStage}`);
        await enqueueWorkForStage(nextStage, vaultPath);
        await persistProgress(vaultPath);
        continue;
      }

      if (task.kind === "extract-insights") {
        const sourceId = task.payload?.sourceId;
        if (!sourceId) {
          appendLog("extract-insights: missing sourceId");
          continue;
        }
        try {
          const source = await loadSource(vaultPath, sourceId);
          if (!source) {
            appendLog(`Source not found: ${sourceId}`);
            continue;
          }
          setStatus("processing", `Extract: ${source.name}`);
          await extractInsightsFromSource(llm, vaultPath, source.text, source.name);
          await persistProgress(vaultPath, sourceId);
          const remaining = getQueueLength();
          if (remaining > 0) appendLog(`${remaining} tasks left in queue.`);
        } catch (err) {
          appendLog(`Error extracting insights from ${sourceId}: ${(err as Error).message}`);
        }
      } else if (task.kind === "organize-vault") {
        setStatus("processing", "Organize: vault");
        try {
          await runOrganizeVault(llm, vaultPath, false);
          await persistProgress(vaultPath);
        } catch (err) {
          appendLog(`Error organizing vault: ${(err as Error).message}`);
        }
      } else if (task.kind === "organize-moc") {
        setStatus("processing", "Organize: MOCs");
        try {
          await runOrganizeVault(llm, vaultPath, true);
          await persistProgress(vaultPath);
        } catch (err) {
          appendLog(`Error building MOCs: ${(err as Error).message}`);
        }
      } else if (task.kind === "link" && task.path) {
        const notePath = task.path;
        setStatus("processing", `Link: ${notePath}`);
        try {
          const content = await readNote(vaultPath, notePath);
          const config = await loadAgentConfig(vaultPath);
          const maxTitlesLink = config.maxTitlesLink ?? 50;
          const useEmbeddings = config.useEmbeddings ?? true;
          const relevantTitles = await getRelevantTitles(vaultPath, content, {
            limit: maxTitlesLink,
            useEmbeddings,
          });
          const currentTitle = path.basename(notePath, ".md");
          const others = relevantTitles.filter((t) => t !== currentTitle);
          if (others.length > 0) {
            await addLinksToNote(llm, vaultPath, notePath, content, others);
            const updatedContent = await readNote(vaultPath, notePath);
            const snippet = updatedContent.slice(0, 300);
            let emb: number[] | undefined;
            if (useEmbeddings) {
              const ec = getEmbeddingClient();
              if (ec) {
                try {
                  emb = await ec.embed(`${currentTitle} ${snippet}`.slice(0, 8000));
                } catch {
                  // index without embedding
                }
              }
            }
            await indexNote(vaultPath, currentTitle, notePath, snippet, emb);
          }
          await persistProgress(vaultPath);
        } catch (err) {
          appendLog(`Error linking ${notePath}: ${(err as Error).message}`);
        }
      } else if (task.kind === "deduce" && task.path) {
        const notePath = task.path;
        setStatus("processing", `Deduce: ${notePath}`);
        try {
          const existingTitles = await getExistingInsightTitles(vaultPath);
          await runDeduceForNote(
            llm,
            vaultPath,
            notePath,
            new Set(existingTitles)
          );
          await persistProgress(vaultPath);
        } catch (err) {
          appendLog(`Error deduce ${notePath}: ${(err as Error).message}`);
        }
      } else if (
        task.kind === "induce" &&
        task.payload?.mocTitle &&
        Array.isArray(task.payload.noteTitles)
      ) {
        setStatus("processing", `Induce: ${task.payload.mocTitle}`);
        try {
          const existingTitles = await getExistingInsightTitles(vaultPath);
          await runInduceForMoc(
            llm,
            vaultPath,
            task.payload.mocTitle,
            task.payload.noteTitles,
            new Set(existingTitles),
            task.payload.mocSummary
          );
          await persistProgress(vaultPath);
        } catch (err) {
          appendLog(
            `Error induce ${task.payload.mocTitle}: ${(err as Error).message}`
          );
        }
      } else if (task.kind === "validate") {
        setStatus("processing", "Validation");
        try {
          await runValidation(vaultPath, llm);
          await persistProgress(vaultPath);
        } catch (err) {
          appendLog(`Error validation: ${(err as Error).message}`);
        }
      }
    }
    state.currentStage = null;
    setStatus("idle", null);
    appendLog("Stopped by user.");
    await persistProgress(vaultPath);
  } catch (err) {
    appendLog(`Agent error: ${(err as Error).message}`);
    state.currentStage = null;
    setStatus("idle", null);
  }
}

export function enqueueSourceForProcessing(sourceId: string): void {
  enqueue({ kind: "extract-insights", stage: "extract", payload: { sourceId } });
}
