import { readFile, writeFile, mkdir } from "fs/promises";
import path from "path";
import type { LLMClient } from "../llm/client.js";
import { appendLog } from "./queue.js";
import { SCIENTIFIC_REASONING_PRINCIPLES } from "./prompts.js";

const SYSTEM_PROMPT = `${SCIENTIFIC_REASONING_PRINCIPLES}

You are building an Obsidian vault. Your job is to make notes atomic: one main concept per note.

Rules:
- Output only valid markdown. Use Obsidian wiki links: [[Note Title]] for links to other notes.
- **Never split a Chain of Thought.** If a premise leads directly to a conclusion in the source text, they must stay in the same atomic note to preserve context. Do not split in the middle of a single argument (premise → conclusion). Split only when there are distinct, self-contained concepts.
- Only split when the note clearly contains multiple distinct, substantial concepts that each deserve their own note.
- Never create empty, trivial, or filler notes. Each new note must have real substantive content (multiple sentences or a full idea), not a single phrase or heading.
- When in doubt, do not split. Prefer leaving the note as-is. It is better to have one good note than several pointless ones.
- If the note is already atomic, very short, or has nothing meaningful to extract, return {"updatedSource": null, "newNotes": []} and stop.`;

export interface SplitResult {
  updatedSource: string | null;
  newNotes: { title: string; content: string }[];
  createdPaths?: string[];
}

export async function trySplitNote(
  llm: LLMClient,
  vaultPath: string,
  relativePath: string,
  content: string
): Promise<SplitResult> {
  const fullPath = path.join(vaultPath, relativePath);
  const fileName = path.basename(relativePath, path.extname(relativePath));

  const userPrompt = `Consider this note (file: ${relativePath}):

\`\`\`markdown
${content}
\`\`\`

Only if this note clearly contains multiple distinct, substantial concepts (each worth a full note with real content):
1. Propose 1-3 new atomic notes. Each must have substantive "content" (multiple sentences or a complete idea), not just a title or one line.
2. Rewrite the original note to replace extracted sections with [[Title]] links and keep a short summary.

If the note is already atomic, very short, repetitive, or has nothing meaningful to split out, return exactly: {"updatedSource": null, "newNotes": []}
Do not create notes that are empty, trivial, or that just restate a heading. When you have said everything possible from this content, return no changes.

Respond in this exact JSON format only, no other text:
{
  "updatedSource": "full markdown for the original file, or null if no change",
  "newNotes": [
    { "title": "Note Title", "content": "markdown content (must be substantive)" }
  ]
}`;

  const raw = await llm.complete(
    [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    { maxTokens: 4096 }
  );

  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    appendLog(`Split: no JSON in response for ${relativePath}`);
    return { updatedSource: null, newNotes: [], createdPaths: [] };
  }

  let parsed: { updatedSource: string | null; newNotes: { title: string; content: string }[] };
  try {
    parsed = JSON.parse(jsonMatch[0]) as SplitResult;
  } catch {
    appendLog(`Split: invalid JSON for ${relativePath}`);
    return { updatedSource: null, newNotes: [], createdPaths: [] };
  }

  const newNotes = Array.isArray(parsed.newNotes) ? parsed.newNotes : [];
  const updatedSource = typeof parsed.updatedSource === "string" ? parsed.updatedSource : null;

  if (updatedSource != null) {
    await writeFile(fullPath, updatedSource, "utf-8");
    appendLog(`Updated: ${relativePath}`);
  }

  const MIN_NOTE_LENGTH = 80;
  const createdPaths: string[] = [];
  for (const note of newNotes) {
    const text = (note.content || "").trim();
    if (!note.title || !text || text.length < MIN_NOTE_LENGTH) continue;
    const safeTitle = note.title.replace(/[/\\?%*:|"<>]/g, "-").trim() || "Untitled";
    const dir = path.dirname(fullPath);
    await mkdir(dir, { recursive: true });
    const newPath = path.join(dir, `${safeTitle}.md`);
    await writeFile(newPath, note.content, "utf-8");
    const rel = path.relative(vaultPath, newPath);
    createdPaths.push(rel);
    appendLog(`Created: ${rel}`);
  }

  return { updatedSource, newNotes, createdPaths };
}

export async function readNote(vaultPath: string, relativePath: string): Promise<string> {
  const full = path.join(vaultPath, relativePath);
  return readFile(full, "utf-8");
}
