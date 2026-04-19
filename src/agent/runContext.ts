let currentRunId: string | null = null;
let dryRun = false;

export function setRunContext(opts: { runId: string; dryRun: boolean }): void {
  currentRunId = opts.runId;
  dryRun = opts.dryRun;
}

export function clearRunContext(): void {
  currentRunId = null;
  dryRun = false;
}

export function getRunContext(): { runId: string | null; dryRun: boolean } {
  return { runId: currentRunId, dryRun };
}
