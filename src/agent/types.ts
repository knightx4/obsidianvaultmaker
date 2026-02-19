export type AgentStatus = "idle" | "processing" | "stopping";

export interface AgentState {
  status: AgentStatus;
  currentTask: string | null;
  log: string[];
  vaultPath: string | null;
  vaultName: string | null;
}

export type TaskKind = "split" | "link";

export interface QueuedTask {
  kind: TaskKind;
  path: string;
  payload?: unknown;
}
