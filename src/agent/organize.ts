import { writeFile, mkdir } from "fs/promises";
import path from "path";
import matter from "gray-matter";
import type { LLMClient } from "../llm/client.js";
import { appendLog } from "./queue.js";
import { listMarkdownFiles, extractNoteTitlesFromVault, readNote } from "./link.js";
import { SCIENTIFIC_REASONING_PRINCIPLES } from "./prompts.js";

const MOC_DIR = "MOCs";
const MOC_PREFIX = MOC_DIR + "/";

const SYSTEM_PROMPT = `${SCIENTIFIC_REASONING_PRINCIPLES}

You are organizing an Obsidian insight vault. Your job is to suggest Map of Content (MOC) notes that group related insights.

Rules:
- Propose 3-8 MOC notes. Each MOC has a title and a list of existing note titles that belong under that theme/topic.
- Use only exact note titles from the list provided. Do not invent notes.
- Each insight note can appear in one or more MOCs if it fits multiple themes.
- Create MOCs that fit the content domain. Prefer grouping by logical role when note types support it. Examples by role: Assumptions, Evidence, Conclusions, Open questions, Contradictions, Causal chains, Key findings, Methods; for strategy use "Key Assumptions", "Critical Risks", "Options"; for fiction use "Themes", "Characters", "Plot threads"; for research use "Key Findings", "Methods", "Open questions"; for technical use "Concepts", "APIs", "Tutorials". Mix thematic and structural groupings as appropriate.
- Use both the note type (when provided) and content themes when grouping.
- Output only valid JSON in this exact format, no other text:
{"mocs": [{"title": "MOC Title", "noteTitles": ["Exact Note Title 1", "Exact Note Title 2"]}]}`;

export interface MOCSpec {
  title: string;
  noteTitles: string[];
}

export interface NoteMetadata {
  type?: string;
  tags?: string[];
}

/** Read Obsidian properties (frontmatter) from a note. Exclude MOCs. */
async function getNoteMetadata(vaultPath: string, relativePath: string): Promise<NoteMetadata | null> {
  if (relativePath.startsWith(MOC_PREFIX) || relativePath.startsWith(MOC_DIR + path.sep)) return null;
  try {
    const raw = await readNote(vaultPath, relativePath);
    const parsed = matter(raw);
    const data = parsed.data as Record<string, unknown>;
    if (!data) return null;
    const type = typeof data.type === "string" && data.type.trim() ? data.type.trim() : undefined;
    const tags = Array.isArray(data.tags)
      ? data.tags.filter((t) => typeof t === "string" && t.trim()).map((t) => String(t).trim())
      : undefined;
    return type || tags ? { type, tags } : null;
  } catch {
    return null;
  }
}

/**
 * Run organize: suggest MOCs from vault note titles and create MOC .md files that link to them.
 * Used for both "organize" and "organize-again" stages.
 */
export async function runOrganizeVault(
  llm: LLMClient,
  vaultPath: string,
  isOrganizeAgain: boolean
): Promise<string[]> {
  const files = await listMarkdownFiles(vaultPath);
  const insightFiles = files.filter((f) => !f.startsWith(MOC_PREFIX) && !f.startsWith(MOC_DIR + path.sep));
  const noteTitles = extractNoteTitlesFromVault(insightFiles);
  if (noteTitles.length === 0) {
    appendLog("Organize: no notes in vault, skipping.");
    return [];
  }

  const titleToMetadata = new Map<string, NoteMetadata>();
  for (const rel of insightFiles) {
    const meta = await getNoteMetadata(vaultPath, rel);
    const title = path.basename(rel, ".md");
    if (meta) titleToMetadata.set(title, meta);
  }

  const context = isOrganizeAgain
    ? "Links between notes already exist. Suggest MOCs that reflect clusters and themes you see. **Stability rule:** Notes with type Conclusion or Theme have 'High Gravity'—do not move them into different MOCs unless there is a major structural change (e.g. a new MOC that clearly supersedes). Keep Conclusion and Theme notes in their current MOC(s) when possible."
    : "Suggest MOCs that group related insights by theme or topic.";

  const highGravityTitles = isOrganizeAgain
    ? noteTitles.filter((t) => {
        const meta = titleToMetadata.get(t);
        return meta?.type === "Conclusion" || meta?.type === "Theme";
      })
    : [];
  const highGravityBlock =
    highGravityTitles.length > 0
      ? `\nHigh-gravity notes (prefer to keep in current MOCs): ${highGravityTitles.join(", ")}`
      : "";

  const noteList = noteTitles
    .map((t) => {
      const meta = titleToMetadata.get(t);
      return meta?.type ? `- ${t} (type: ${meta.type})` : `- ${t}`;
    })
    .join("\n");

  const userPrompt = `Vault note titles (use these exact strings in noteTitles):
${noteList}
${highGravityBlock}

${context}

Output only a JSON object: {"mocs": [{"title": "MOC Title", "noteTitles": ["Exact Note Title", ...]}]}`;

  const raw = await llm.complete(
    [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    { maxTokens: 2048 }
  );

  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    appendLog("Organize: no JSON in response.");
    return [];
  }
  let parsed: { mocs?: MOCSpec[] };
  try {
    parsed = JSON.parse(jsonMatch[0]) as { mocs?: MOCSpec[] };
  } catch {
    appendLog("Organize: invalid JSON.");
    return [];
  }
  const mocs = Array.isArray(parsed.mocs) ? parsed.mocs : [];
  const created: string[] = [];
  const mocDirFull = path.join(vaultPath, MOC_DIR);
  await mkdir(mocDirFull, { recursive: true });

  const validTitles = new Set(noteTitles);
  for (const moc of mocs) {
    if (!moc.title?.trim()) continue;
    const safeTitle = moc.title.replace(/[/\\?%*:|"<>]/g, "-").trim() || "Untitled";
    const noteTitlesFiltered = Array.isArray(moc.noteTitles)
      ? moc.noteTitles.filter((t) => validTitles.has(t))
      : [];
    const bodyContent = [
      `# ${moc.title}`,
      "",
      ...noteTitlesFiltered.map((t) => `- [[${t}]]`),
    ].join("\n");
    const rel = path.join(MOC_DIR, `${safeTitle}.md`);
    const full = path.join(vaultPath, rel);

    let summary = "";
    try {
      const summaryPrompt = `MOC title: ${moc.title}. Note titles in this MOC: ${noteTitlesFiltered.join(", ")}. Write a 3-sentence executive summary of what this cluster is about. Output only the summary, no label.`;
      summary = await llm.complete(
        [
          {
            role: "system",
            content:
              "You write concise executive summaries for a group of notes. Output only the summary text, 3 sentences or fewer.",
          },
          { role: "user", content: summaryPrompt },
        ],
        { maxTokens: 150 }
      );
      summary = summary.trim();
    } catch {
      // non-fatal; continue without summary
    }

    const frontmatter: Record<string, unknown> = summary ? { summary } : {};
    const content = matter.stringify(bodyContent, frontmatter, {
      delimiters: ["---", "---"],
    });
    await writeFile(full, content, "utf-8");
    created.push(rel);
    appendLog(`MOC: ${rel}`);
  }
  return created;
}

/** List all MOC files and parse each for note titles and optional summary. Used to enqueue induce tasks. */
export async function getMocList(
  vaultPath: string
): Promise<Array<{ mocPath: string; mocTitle: string; noteTitles: string[]; mocSummary?: string }>> {
  const files = await listMarkdownFiles(vaultPath);
  const mocFiles = files.filter(
    (f) => f.startsWith(MOC_PREFIX) || f.startsWith(MOC_DIR + path.sep)
  );
  const result: Array<{
    mocPath: string;
    mocTitle: string;
    noteTitles: string[];
    mocSummary?: string;
  }> = [];
  for (const mocPath of mocFiles) {
    const raw = await readNote(vaultPath, mocPath);
    const parsed = matter(raw);
    const body = (parsed.content ?? "").trim();
    const data = parsed.data as Record<string, unknown> | undefined;
    const summary =
      data && typeof data.summary === "string" && data.summary.trim()
        ? data.summary.trim()
        : undefined;
    const title = path.basename(mocPath, ".md");
    const noteTitles: string[] = [];
    const linkRegex = /\[\[([^\]]+)\]\]/g;
    let m: RegExpExecArray | null;
    while ((m = linkRegex.exec(body)) !== null) {
      noteTitles.push(m[1].trim());
    }
    result.push({ mocPath, mocTitle: title, noteTitles, mocSummary: summary });
  }
  return result;
}
