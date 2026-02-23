import type { QueuedTask } from "./types.js";
import type { Stage } from "./types.js";
import { notifyAgentUpdate } from "./events.js";

const queue: QueuedTask[] = [];
const maxLogLines = 100;

function notify(): void {
  notifyAgentUpdate();
}

export function enqueue(task: QueuedTask): void {
  queue.push(task);
  notify();
}

export function enqueueMany(tasks: QueuedTask[]): void {
  queue.push(...tasks);
  notify();
}

export function dequeue(): QueuedTask | undefined {
  const out = queue.shift();
  if (out) notify();
  return out;
}

/** Dequeue the first task that matches the given stage. */
export function dequeueForStage(stage: Stage): QueuedTask | undefined {
  const idx = queue.findIndex((t) => t.stage === stage);
  if (idx === -1) return undefined;
  const out = queue.splice(idx, 1)[0];
  notify();
  return out;
}

/** True if there is at least one task for the given stage. */
export function hasTaskForStage(stage: Stage): boolean {
  return queue.some((t) => t.stage === stage);
}

export function getQueueLength(): number {
  return queue.length;
}

export function clearQueue(): void {
  queue.length = 0;
  notify();
}

/** Snapshot of the queue for persistence. */
export function getQueueSnapshot(): QueuedTask[] {
  return queue.map((t) => ({ ...t }));
}

/** Restore queue from a saved snapshot (replaces current queue). */
export function restoreQueue(tasks: QueuedTask[]): void {
  queue.length = 0;
  queue.push(...tasks);
  notify();
}

const log: string[] = [];

export function appendLog(line: string): void {
  log.push(line);
  if (log.length > maxLogLines) log.shift();
  notify();
}

export function getLog(): string[] {
  return [...log];
}

export function clearLog(): void {
  log.length = 0;
  notify();
}
