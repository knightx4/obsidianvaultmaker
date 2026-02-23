export type AgentStatus = "idle" | "processing" | "stopping";

export type Stage =
  | "extract"
  | "organize"
  | "connect"
  | "deduce"
  | "induce"
  | "organize-again"
  | "validate";

export const STAGES: Stage[] = [
  "extract",
  "organize",
  "connect",
  "deduce",
  "induce",
  "organize-again",
  "validate",
];

export interface AgentState {
  status: AgentStatus;
  currentTask: string | null;
  currentStage: Stage | null;
  log: string[];
  vaultPath: string | null;
  vaultName: string | null;
  sourceDir: string | null;
}

export type TaskKind =
  | "extract-insights"
  | "organize-vault"
  | "link"
  | "organize-moc"
  | "deduce"
  | "induce"
  | "validate";

export interface QueuedTask {
  kind: TaskKind;
  stage: Stage;
  path?: string;
  payload?: {
    sourceId?: string;
    mocPath?: string;
    mocTitle?: string;
    noteTitles?: string[];
    mocSummary?: string;
  };
}
