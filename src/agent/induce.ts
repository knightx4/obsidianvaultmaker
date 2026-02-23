import { writeFile, mkdir } from "fs/promises";
import path from "path";
import matter from "gray-matter";
import type { LLMClient } from "../llm/client.js";
import { appendLog } from "./queue.js";
import { readNote, findPathByTitle } from "./link.js";
import { RELATIONSHIP_TAXONOMY, stripMarkdownFences } from "./prompts.js";
import { loadAgentConfig } from "../storage/agentConfig.js";
import { indexNote } from "../retrieval/embeddingIndex.js";
import { getEmbeddingClient } from "../retrieval/retrieve.js";

const INSIGHTS_DIR = "Insights";

const INDUCE_SYSTEM_PROMPT = `You are the inductive agent. Given a cluster of notes (one MOC), identify recurring patterns, themes, or general hypotheses. Create Meta-Notes (type: Theme) that link back to the supporting evidence.

Rules:
- Look for cross-pollination: patterns or hypotheses that span multiple notes in the cluster.
- Create one note per distinct theme or pattern. Each note must link back to the supporting notes using "Relationship:: Evidence for [[Note Title]]" or "Relationship:: Supports [[Note Title]]".
- Use exact note titles from the list provided. Do not invent titles.
- If no clear theme or pattern emerges, return {"themes": []}.
- Output only valid JSON: {"themes": [{"title": "Theme or Hypothesis Title", "content": "markdown with Relationship:: Evidence for [[Supporting Note]] links", "noteTitles": ["Exact Note 1", "Exact Note 2"]}]}. No other text.`;

/**
 * Run inductive step for one MOC: read note contents (and optionally MOC summary), ask LLM for themes/hypotheses, write new Theme notes.
 */
export async function runInduceForMoc(
  llm: LLMClient,
  vaultPath: string,
  mocTitle: string,
  noteTitles: string[],
  existingTitles: Set<string>,
  mocSummary?: string
): Promise<string[]> {
  if (noteTitles.length === 0) return [];

  const noteList = noteTitles.map((t) => `- ${t}`).join("\n");
  const bodies: string[] = [];
  for (const title of noteTitles) {
    const rel = await findPathByTitle(vaultPath, title);
    if (rel) {
      try {
        const raw = await readNote(vaultPath, rel);
        const parsed = matter(raw);
        bodies.push(`## ${title}\n${(parsed.content ?? "").trim()}`);
      } catch {
        bodies.push(`## ${title}\n(no content)`);
      }
    } else {
      bodies.push(`## ${title}\n(not found)`);
    }
  }

  const summaryBlock = mocSummary
    ? `\nMOC Summary (big picture):\n${mocSummary}\n\n`
    : "";

  const userPrompt = `MOC: ${mocTitle}
Note titles in this cluster: ${noteList}
${summaryBlock}Note contents:
${bodies.join("\n\n")}

Existing theme/note titles in vault (do not duplicate): ${[...existingTitles].slice(0, 100).join(", ")}

Identify recurring patterns or hypotheses. For each, provide title, content (with Relationship:: Evidence for [[Exact Note Title]] for supporting notes), and noteTitles array. Allowed relationship types: ${RELATIONSHIP_TAXONOMY.join(", ")}.`;

  const response = await llm.complete(
    [
      { role: "system", content: INDUCE_SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    { maxTokens: 2048 }
  );

  const jsonMatch = response.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return [];
  let parsed: { themes?: Array<{ title: string; content: string; noteTitles?: string[] }> };
  try {
    parsed = JSON.parse(jsonMatch[0]) as typeof parsed;
  } catch {
    return [];
  }
  const themes = Array.isArray(parsed.themes) ? parsed.themes : [];
  const created: string[] = [];

  for (const theme of themes) {
    if (!theme.title?.trim() || !theme.content?.trim()) continue;
    const safeTitle = theme.title.replace(/[/\\?%*:|"<>]/g, "-").trim() || "Untitled";
    if (existingTitles.has(safeTitle)) continue;

    const frontmatter: Record<string, unknown> = {
      type: "Theme",
      source: "induce",
    };
    const output = matter.stringify(stripMarkdownFences(theme.content.trim()), frontmatter, {
      delimiters: ["---", "---"],
    });
    const newRel = path.join(INSIGHTS_DIR, `${safeTitle}.md`);
    const fullPath = path.join(vaultPath, newRel);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, output, "utf-8");
    created.push(newRel);
    existingTitles.add(safeTitle);
    appendLog(`Induce: ${newRel}`);
    const body = stripMarkdownFences(theme.content.trim());
    const snippet = body.slice(0, 300);
    let emb: number[] | undefined;
    const config = await loadAgentConfig(vaultPath);
    if (config.useEmbeddings !== false) {
      const ec = getEmbeddingClient();
      if (ec) {
        try {
          emb = await ec.embed(`${safeTitle} ${snippet}`.slice(0, 8000));
        } catch {
          // index without embedding
        }
      }
    }
    await indexNote(vaultPath, safeTitle, newRel, snippet, emb);
  }
  return created;
}
