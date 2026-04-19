import { readFile, writeFile, mkdir } from "fs/promises";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const VAULTMAKER_DIR = ".vaultmaker";
const MANIFEST_FILE = "manifest.json";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface PipelineManifest {
  schemaVersion: number;
  vaultmakerVersion: string;
  lastRunId: string | null;
  lastRunAt: string | null;
  dryRun: boolean;
  stagesCompleted: string[];
  models?: {
    chat?: string;
    embedding?: string;
  };
}

const DEFAULT_MANIFEST: PipelineManifest = {
  schemaVersion: 1,
  vaultmakerVersion: "unknown",
  lastRunId: null,
  lastRunAt: null,
  dryRun: false,
  stagesCompleted: [],
};

function getManifestPath(vaultPath: string): string {
  return path.join(vaultPath, VAULTMAKER_DIR, MANIFEST_FILE);
}

export function getVaultmakerVersion(): string {
  try {
    const pkgPath = path.resolve(__dirname, "../../package.json");
    const raw = readFileSync(pkgPath, "utf-8");
    const pkg = JSON.parse(raw) as { version?: string };
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

export async function loadManifest(vaultPath: string): Promise<PipelineManifest> {
  try {
    const raw = await readFile(getManifestPath(vaultPath), "utf-8");
    const data = JSON.parse(raw) as Partial<PipelineManifest>;
    return {
      ...DEFAULT_MANIFEST,
      ...data,
      schemaVersion: typeof data.schemaVersion === "number" ? data.schemaVersion : DEFAULT_MANIFEST.schemaVersion,
      vaultmakerVersion:
        typeof data.vaultmakerVersion === "string" ? data.vaultmakerVersion : getVaultmakerVersion(),
      lastRunId: typeof data.lastRunId === "string" || data.lastRunId === null ? data.lastRunId ?? null : null,
      lastRunAt: typeof data.lastRunAt === "string" || data.lastRunAt === null ? data.lastRunAt ?? null : null,
      dryRun: typeof data.dryRun === "boolean" ? data.dryRun : false,
      stagesCompleted: Array.isArray(data.stagesCompleted)
        ? data.stagesCompleted.filter((s): s is string => typeof s === "string")
        : [],
      models: data.models && typeof data.models === "object" ? data.models : undefined,
    };
  } catch {
    return { ...DEFAULT_MANIFEST, vaultmakerVersion: getVaultmakerVersion() };
  }
}

export async function saveManifest(vaultPath: string, manifest: Partial<PipelineManifest>): Promise<void> {
  const existing = await loadManifest(vaultPath);
  const merged: PipelineManifest = {
    ...existing,
    ...manifest,
    vaultmakerVersion: manifest.vaultmakerVersion ?? existing.vaultmakerVersion ?? getVaultmakerVersion(),
  };
  const dir = path.join(vaultPath, VAULTMAKER_DIR);
  await mkdir(dir, { recursive: true });
  await writeFile(getManifestPath(vaultPath), JSON.stringify(merged, null, 2), "utf-8");
}

export async function updateRunManifest(
  vaultPath: string,
  patch: {
    runId: string;
    dryRun?: boolean;
    stagesCompleted?: string[];
    models?: PipelineManifest["models"];
  }
): Promise<void> {
  await saveManifest(vaultPath, {
    lastRunId: patch.runId,
    lastRunAt: new Date().toISOString(),
    dryRun: patch.dryRun ?? false,
    stagesCompleted: patch.stagesCompleted ?? [],
    models: patch.models,
  });
}
