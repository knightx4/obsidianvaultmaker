const listeners = new Set<() => void>();

export function subscribeAgentUpdates(callback: () => void): () => void {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

export function notifyAgentUpdate(): void {
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      // ignore per-listener errors
    }
  }
}
