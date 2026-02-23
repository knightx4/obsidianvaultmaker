import { readFile, writeFile, mkdir } from "fs/promises";
import path from "path";
import type { QueuedTask } from "../agent/types.js";
import type { Stage } from "../agent/types.js";
import { restoreQueue } from "../agent/queue.js";

const PROGRESS_DIR = ".vaultmaker";
const PROGRESS_FILE = "progress.json";

export interface ProgressData {
  processedSourceIds: string[];
  currentStage: Stage | null;
  queue: QueuedTask[];
  lastUpdated: string;
}

function getProgressPath(vaultPath: string): string {
  return path.join(vaultPath, PROGRESS_DIR, PROGRESS_FILE);
}

/**
 * Load progress for a vault. Restores queue in memory; does not set agent state.
 * Returns null if no progress file or invalid.
 */
export async function loadProgress(vaultPath: string): Promise<ProgressData | null> {
  try {
    const filePath = getProgressPath(vaultPath);
    const raw = await readFile(filePath, "utf-8");
    const data = JSON.parse(raw) as ProgressData;
    if (!data || !Array.isArray(data.processedSourceIds)) return null;
    if (!Array.isArray(data.queue)) return null;
    data.queue = data.queue.filter(
      (t) => t && typeof t.kind === "string" && typeof t.stage === "string"
    );
    data.processedSourceIds = data.processedSourceIds.filter((id) => typeof id === "string");
    return data;
  } catch {
    return null;
  }
}

/**
 * Save progress for a vault. Caller must pass current queue snapshot (e.g. getQueueSnapshot()).
 */
export async function saveProgress(
  vaultPath: string,
  data: Omit<ProgressData, "lastUpdated"> & { lastUpdated?: string }
): Promise<void> {
  const dir = path.join(vaultPath, PROGRESS_DIR);
  await mkdir(dir, { recursive: true });
  const full: ProgressData = {
    processedSourceIds: data.processedSourceIds ?? [],
    currentStage: data.currentStage ?? null,
    queue: data.queue ?? [],
    lastUpdated: data.lastUpdated ?? new Date().toISOString(),
  };
  const filePath = path.join(dir, PROGRESS_FILE);
  await writeFile(filePath, JSON.stringify(full, null, 0), "utf-8");
}

/**
 * Get a short summary of progress for display (e.g. in status API).
 */
export async function getProgressSummary(vaultPath: string): Promise<{
  processedCount: number;
  lastUpdated: string | null;
} | null> {
  const data = await loadProgress(vaultPath);
  if (!data) return null;
  return {
    processedCount: data.processedSourceIds.length,
    lastUpdated: data.lastUpdated ?? null,
  };
}

/**
 * Restore agent state from progress: restore queue and return currentStage.
 * Caller should set state.currentStage from returned value.
 * If currentQueueLength > 0, the in-memory queue is not overwritten (avoids wiping a live queue when saving config).
 */
export async function restoreFromProgress(
  vaultPath: string,
  currentQueueLength: number = 0
): Promise<{
  restored: boolean;
  currentStage: Stage | null;
  processedCount: number;
  queueLength: number;
}> {
  const data = await loadProgress(vaultPath);
  if (!data || data.queue.length === 0) {
    return { restored: false, currentStage: null, processedCount: 0, queueLength: 0 };
  }
  if (currentQueueLength > 0) {
    return { restored: false, currentStage: null, processedCount: data.processedSourceIds.length, queueLength: currentQueueLength };
  }
  restoreQueue(data.queue);
  return {
    restored: true,
    currentStage: data.currentStage,
    processedCount: data.processedSourceIds.length,
    queueLength: data.queue.length,
  };
}
