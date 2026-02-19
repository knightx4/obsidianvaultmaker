import { readFile, writeFile } from "fs/promises";
import path from "path";
import type { LLMClient } from "../llm/client.js";
import { appendLog } from "./queue.js";

const SYSTEM_PROMPT = `You are building an Obsidian vault. Your job is to add connections between notes using wiki links only when they are meaningful.

Rules:
- Use only Obsidian wiki links: [[Note Title]] (exact note title as it appears in the list). Do not invent titles.
- Only add a link when there is a real conceptual connection (same topic, cause-effect, part-whole, reference). Do not link for the sake of linking.
- If there are no meaningful connections to other notes in the list, output the exact same markdown unchanged. It is fine to add zero links when nothing fits.
- When you have connected everything that truly relates, stop. Output only the complete markdown (either with new [[links]] or unchanged).`;

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

If any of these notes genuinely relate to this note's ideas, add [[Note Title]] links where they fit. If none do, return the exact same markdown unchanged. Output only the markdown, no explanation.`;

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
  const { readdir } = await import("fs/promises");
  const fullDir = path.join(vaultPath, dir);
  const entries = await readdir(fullDir, { withFileTypes: true });
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
