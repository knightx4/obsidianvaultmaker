import { readFile, writeFile, mkdir } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CONFIG_DIR = path.resolve(__dirname, "..", "..", "data");
const CONFIG_FILE = "vaultConfig.json";

export interface VaultConfig {
  vaultPath: string | null;
  vaultName: string | null;
  sourceDir: string | null;
}

function getConfigPath(): string {
  return path.join(CONFIG_DIR, CONFIG_FILE);
}

export async function loadVaultConfig(): Promise<VaultConfig> {
  try {
    const filePath = getConfigPath();
    const raw = await readFile(filePath, "utf-8");
    const data = JSON.parse(raw) as VaultConfig;
    return {
      vaultPath: typeof data.vaultPath === "string" ? data.vaultPath : null,
      vaultName: typeof data.vaultName === "string" ? data.vaultName : null,
      sourceDir: typeof data.sourceDir === "string" ? data.sourceDir : null,
    };
  } catch {
    return { vaultPath: null, vaultName: null, sourceDir: null };
  }
}

export async function saveVaultConfig(config: Partial<VaultConfig>): Promise<void> {
  const existing = await loadVaultConfig();
  await mkdir(CONFIG_DIR, { recursive: true });
  const updated: VaultConfig = {
    vaultPath: config.vaultPath !== undefined ? config.vaultPath : existing.vaultPath,
    vaultName: config.vaultName !== undefined ? config.vaultName : existing.vaultName,
    sourceDir: config.sourceDir !== undefined ? config.sourceDir : existing.sourceDir,
  };
  const filePath = getConfigPath();
  await writeFile(filePath, JSON.stringify(updated, null, 2), "utf-8");
}
