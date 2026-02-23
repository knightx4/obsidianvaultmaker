import { readFile, writeFile, mkdir } from "fs/promises";
import path from "path";

const CONFIG_DIR_NAME = ".vaultmaker";
const AGENT_CONFIG_FILE = "agentConfig.json";

export interface AgentConfig {
  maxTitlesExtract?: number;
  maxTitlesLink?: number;
  maxTitlesOrganize?: number;
  dedupSimilarityThreshold?: number;
  useEmbeddings?: boolean;
}

const DEFAULTS: Required<AgentConfig> = {
  maxTitlesExtract: 80,
  maxTitlesLink: 50,
  maxTitlesOrganize: 400,
  dedupSimilarityThreshold: 0.92,
  useEmbeddings: true,
};

function getConfigPath(vaultPath: string): string {
  return path.join(vaultPath, CONFIG_DIR_NAME, AGENT_CONFIG_FILE);
}

/**
 * Load per-vault agent config. Missing file or fields use defaults.
 */
export async function loadAgentConfig(vaultPath: string): Promise<Required<AgentConfig>> {
  try {
    const filePath = getConfigPath(vaultPath);
    const raw = await readFile(filePath, "utf-8");
    const data = JSON.parse(raw) as AgentConfig;
    if (!data || typeof data !== "object") return { ...DEFAULTS };
    return {
      maxTitlesExtract: typeof data.maxTitlesExtract === "number" ? data.maxTitlesExtract : DEFAULTS.maxTitlesExtract,
      maxTitlesLink: typeof data.maxTitlesLink === "number" ? data.maxTitlesLink : DEFAULTS.maxTitlesLink,
      maxTitlesOrganize: typeof data.maxTitlesOrganize === "number" ? data.maxTitlesOrganize : DEFAULTS.maxTitlesOrganize,
      dedupSimilarityThreshold:
        typeof data.dedupSimilarityThreshold === "number"
          ? data.dedupSimilarityThreshold
          : DEFAULTS.dedupSimilarityThreshold,
      useEmbeddings: typeof data.useEmbeddings === "boolean" ? data.useEmbeddings : DEFAULTS.useEmbeddings,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

/**
 * Save per-vault agent config. Partial updates merge with existing.
 */
export async function saveAgentConfig(
  vaultPath: string,
  config: Partial<AgentConfig>
): Promise<void> {
  const existing = await loadAgentConfig(vaultPath);
  const dir = path.join(vaultPath, CONFIG_DIR_NAME);
  await mkdir(dir, { recursive: true });
  const updated: AgentConfig = {
    maxTitlesExtract: config.maxTitlesExtract ?? existing.maxTitlesExtract,
    maxTitlesLink: config.maxTitlesLink ?? existing.maxTitlesLink,
    maxTitlesOrganize: config.maxTitlesOrganize ?? existing.maxTitlesOrganize,
    dedupSimilarityThreshold: config.dedupSimilarityThreshold ?? existing.dedupSimilarityThreshold,
    useEmbeddings: config.useEmbeddings ?? existing.useEmbeddings,
  };
  const filePath = path.join(dir, AGENT_CONFIG_FILE);
  await writeFile(filePath, JSON.stringify(updated, null, 2), "utf-8");
}
