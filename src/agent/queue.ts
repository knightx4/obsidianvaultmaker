import type { QueuedTask } from "./types.js";

const queue: QueuedTask[] = [];
const maxLogLines = 100;

export function enqueue(task: QueuedTask): void {
  queue.push(task);
}

export function enqueueMany(tasks: QueuedTask[]): void {
  queue.push(...tasks);
}

export function dequeue(): QueuedTask | undefined {
  return queue.shift();
}

export function getQueueLength(): number {
  return queue.length;
}

export function clearQueue(): void {
  queue.length = 0;
}

const log: string[] = [];

export function appendLog(line: string): void {
  log.push(line);
  if (log.length > maxLogLines) log.shift();
}

export function getLog(): string[] {
  return [...log];
}

export function clearLog(): void {
  log.length = 0;
}
