import { readFile, writeFile, readdir } from "fs/promises";
import path from "path";
import type { LLMClient } from "../llm/client.js";
import { appendLog } from "./queue.js";
import { SCIENTIFIC_REASONING_PRINCIPLES, RELATIONSHIP_TAXONOMY } from "./prompts.js";
import { applyRelationsSection } from "./applyRelations.js";

const JSON_SYSTEM_PROMPT = `${SCIENTIFIC_REASONING_PRINCIPLES}

You are building an Obsidian vault. Your job is to propose connections between notes using wiki links only when they are meaningful and the relationship is nameable.

Rules:
- Use only Obsidian wiki links: [[Note Title]] (exact note title as it appears in the list). Do not invent titles.
- Only use relationship types from this list: ${RELATIONSHIP_TAXONOMY.join(", ")}.
- Output only valid JSON: {"relationshipLines": ["Relationship:: Type [[Note Title]]", ...]}. Use an empty array if nothing fits.`;

export async function addLinksToNote(
  llm: LLMClient,
  vaultPath: string,
  relativePath: string,
  content: string,
  otherNoteTitles: string[],
  options?: { dryRun?: boolean }
): Promise<string | null> {
  if (otherNoteTitles.length === 0) return null;

  const userPrompt = `Note to update (file: ${relativePath}):

\`\`\`markdown
${content}
\`\`\`

Other notes in the vault (use these exact titles in [[links]] only when there is a real conceptual connection):
${otherNoteTitles.map((t) => `- ${t}`).join("\n")}

Return JSON only: {"relationshipLines": ["Relationship:: <type> [[Exact Title]]", ...]}. Allowed types: ${RELATIONSHIP_TAXONOMY.join(
    ", "
  )}. Empty array if none apply.`;

  const updated = await llm.complete(
    [{ role: "system", content: JSON_SYSTEM_PROMPT }, { role: "user", content: userPrompt }],
    { maxTokens: 2048 }
  );

  const jsonMatch = updated.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  let parsed: { relationshipLines?: unknown };
  try {
    parsed = JSON.parse(jsonMatch[0]) as { relationshipLines?: unknown };
  } catch {
    return null;
  }
  const lines = Array.isArray(parsed.relationshipLines)
    ? parsed.relationshipLines.filter((l): l is string => typeof l === "string" && l.trim().length > 0)
    : [];

  if (lines.length === 0) return null;

  const merged = applyRelationsSection(content, lines);
  if (merged === content) return null;

  if (options?.dryRun) {
    appendLog(`Dry-run: would link ${relativePath} (${lines.length} line(s))`);
    return merged;
  }

  const fullPath = path.join(vaultPath, relativePath);
  await writeFile(fullPath, merged, "utf-8");
  appendLog(`Linked: ${relativePath}`);
  return merged;
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
export async function findPathByTitle(vaultPath: string, title: string): Promise<string | null> {
  const files = await listMarkdownFiles(vaultPath);
  const normalized = title.trim();
  const found = files.find((f) => path.basename(f, ".md") === normalized);
  return found ?? null;
}
