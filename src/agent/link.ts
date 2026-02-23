import { readFile, writeFile, readdir } from "fs/promises";
import path from "path";
import type { LLMClient } from "../llm/client.js";
import { appendLog } from "./queue.js";
import {
  SCIENTIFIC_REASONING_PRINCIPLES,
  RELATIONSHIP_TAXONOMY,
} from "./prompts.js";

const SYSTEM_PROMPT = `${SCIENTIFIC_REASONING_PRINCIPLES}

You are building an Obsidian vault. Your job is to add connections between notes using wiki links only when they are meaningful and the relationship is nameable.

Rules:
- Use only Obsidian wiki links: [[Note Title]] (exact note title as it appears in the list). Do not invent titles.
- Only add a link when you can state the logical relationship in one short phrase. Use the machine-readable format: "Relationship:: <type> [[Note Title]]" (e.g. "Relationship:: Supports [[X]]", "Relationship:: Evidence for [[Y]]"). Allowed types: ${RELATIONSHIP_TAXONOMY.join(", ")}.
- Place each link in a sentence that conveys the relationship, or on its own line as "Relationship:: Type [[Title]]".
- If there are no meaningful, nameable connections to other notes in the list, output the exact same markdown unchanged. It is fine to add zero links when nothing fits.
- Output only the complete markdown (either with new Relationship:: Type [[links]] or unchanged).`;

export async function addLinksToNote(
  llm: LLMClient,
  vaultPath: string,
  relativePath: string,
  content: string,
  otherNoteTitles: string[]
): Promise<string | null> {
  if (otherNoteTitles.length === 0) return null;

  const userPrompt = `Note to update (file: ${relativePath}):

\`\`\`markdown
${content}
\`\`\`

Other notes in the vault (use these exact titles in [[links]] only when there is a real conceptual connection):
${otherNoteTitles.map((t) => `- ${t}`).join("\n")}

If any of these notes genuinely relate to this note's ideas, add links using the format "Relationship:: <type> [[Note Title]]" (e.g. "Relationship:: Evidence for [[X]]" or "Relationship:: Contradicts [[Y]]"). Allowed relationship types: ${RELATIONSHIP_TAXONOMY.join(", ")}. Only add a link when you can name the relationship. If none do, return the exact same markdown unchanged. Output only the markdown, no explanation.`;

  const updated = await llm.complete(
    [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    { maxTokens: 4096 }
  );

  const trimmed = updated.trim();
  if (!trimmed || trimmed === content) return null;

  const fullPath = path.join(vaultPath, relativePath);
  await writeFile(fullPath, trimmed, "utf-8");
  appendLog(`Linked: ${relativePath}`);
  return trimmed;
}

export function extractNoteTitlesFromVault(fileList: string[]): string[] {
  return fileList
    .filter((f) => f.endsWith(".md"))
    .map((f) => path.basename(f, ".md"))
    .filter(Boolean);
}

function normalizeRel(p: string): string {
  return p.split(path.sep).join("/");
}

export async function listMarkdownFiles(vaultPath: string, dir: string = ""): Promise<string[]> {
  const fullDir = path.join(vaultPath, dir);
  let entries;
  try {
    entries = await readdir(fullDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];

  for (const e of entries) {
    const rel = normalizeRel(dir ? `${dir}/${e.name}` : e.name);
    if (e.isDirectory()) {
      const sub = await listMarkdownFiles(vaultPath, rel);
      out.push(...sub);
    } else if (e.name.endsWith(".md")) {
      out.push(rel);
    }
  }
  return out;
}

export async function readNote(vaultPath: string, relativePath: string): Promise<string> {
  const full = path.join(vaultPath, relativePath);
  return readFile(full, "utf-8");
}

/** Find the first .md file in the vault whose basename (without .md) equals the given title. */
export async function findPathByTitle(
  vaultPath: string,
  title: string
): Promise<string | null> {
  const files = await listMarkdownFiles(vaultPath);
  const normalized = title.trim();
  const found = files.find((f) => path.basename(f, ".md") === normalized);
  return found ?? null;
}
