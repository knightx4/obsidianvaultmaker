import { writeFile, mkdir } from "fs/promises";
import path from "path";
import matter from "gray-matter";
import type { LLMClient } from "../llm/client.js";
import { appendLog } from "./queue.js";
import { listMarkdownFiles, extractNoteTitlesFromVault, readNote } from "./link.js";
import { SCIENTIFIC_REASONING_PRINCIPLES } from "./prompts.js";
import { stripMarkdownFences } from "./prompts.js";
import { loadAgentConfig } from "../storage/agentConfig.js";
import { loadIndex, indexNote } from "../retrieval/embeddingIndex.js";
import { getEmbeddingClient, similarity } from "../retrieval/retrieve.js";

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

/** Suggest MOCs for a subset of note titles. Returns MOCSpec[] (no file I/O). */
async function suggestMocs(
  llm: LLMClient,
  noteTitles: string[],
  titleToMetadata: Map<string, NoteMetadata>,
  highGravityTitles: string[],
  context: string
): Promise<MOCSpec[]> {
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
  if (!jsonMatch) return [];
  let parsed: { mocs?: MOCSpec[] };
  try {
    parsed = JSON.parse(jsonMatch[0]) as { mocs?: MOCSpec[] };
  } catch {
    return [];
  }
  return Array.isArray(parsed.mocs) ? parsed.mocs : [];
}

/** Cluster note titles by embedding similarity (greedy). */
function clusterByEmbedding(
  noteTitles: string[],
  titleToEmbedding: Map<string, number[]>,
  maxClusters: number
): string[][] {
  const n = noteTitles.length;
  const K = Math.min(maxClusters, Math.max(1, Math.ceil(n / 50)));
  const targetSize = Math.ceil(n / K);
  const withEmb = noteTitles.filter((t) => titleToEmbedding.has(t));
  const withoutEmb = noteTitles.filter((t) => !titleToEmbedding.has(t));
  const clusters: string[][] = [];
  const assigned = new Set<string>();
  for (const t of withEmb) {
    if (assigned.has(t)) continue;
    const emb = titleToEmbedding.get(t)!;
    const candidates = withEmb.filter((u) => !assigned.has(u) && u !== t);
    const scored = candidates.map((u) => ({ title: u, sim: similarity(emb, titleToEmbedding.get(u)!) }));
    scored.sort((a, b) => b.sim - a.sim);
    const cluster = [t, ...scored.slice(0, targetSize - 1).map((s) => s.title)];
    cluster.forEach((c) => assigned.add(c));
    clusters.push(cluster);
  }
  if (withoutEmb.length > 0) {
    if (clusters.length > 0) clusters[0].push(...withoutEmb);
    else clusters.push([...withoutEmb]);
  }
  return clusters;
}

/** Write MOC files to vault from MOCSpec[]. titleSuffix is appended to each MOC title (e.g. " – Cluster 1"). */
async function writeMocs(
  vaultPath: string,
  mocs: MOCSpec[],
  noteTitles: string[],
  llm: LLMClient,
  titleSuffix: string
): Promise<string[]> {
  const validTitles = new Set(noteTitles);
  const created: string[] = [];
  const mocDirFull = path.join(vaultPath, MOC_DIR);
  await mkdir(mocDirFull, { recursive: true });
  for (const moc of mocs) {
    if (!moc.title?.trim()) continue;
    const baseTitle = moc.title.replace(/[/\\?%*:|"<>]/g, "-").trim() || "Untitled";
    const safeTitle = titleSuffix ? `${baseTitle}${titleSuffix}`.replace(/[/\\?%*:|"<>]/g, "-") : baseTitle;
    const noteTitlesFiltered = Array.isArray(moc.noteTitles)
      ? moc.noteTitles.filter((t) => validTitles.has(t))
      : [];
    const bodyContent = [
      `# ${moc.title}${titleSuffix}`,
      "",
      ...noteTitlesFiltered.map((t) => `- [[${t}]]`),
    ].join("\n");
    const rel = path.join(MOC_DIR, `${safeTitle}.md`);
    const full = path.join(vaultPath, rel);
    let summary = "";
    try {
      const summaryPrompt = `MOC title: ${moc.title}. Note titles in this MOC: ${noteTitlesFiltered.join(", ")}. Write a 3-sentence executive summary. Output only the summary.`;
      summary = await llm.complete(
        [
          { role: "system", content: "You write concise executive summaries. Output only the summary text, 3 sentences or fewer." },
          { role: "user", content: summaryPrompt },
        ],
        { maxTokens: 150 }
      );
      summary = stripMarkdownFences(summary.trim());
    } catch {
      // non-fatal
    }
    const frontmatter: Record<string, unknown> = summary ? { summary } : {};
    const content = matter.stringify(bodyContent, frontmatter, { delimiters: ["---", "---"] });
    await writeFile(full, content, "utf-8");
    created.push(rel);
    appendLog(`MOC: ${rel}`);
  }
  return created;
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
  const config = await loadAgentConfig(vaultPath);
  const maxTitlesOrganize = config.maxTitlesOrganize ?? 400;

  const files = await listMarkdownFiles(vaultPath);
  const insightFiles = files.filter((f) => !f.startsWith(MOC_PREFIX) && !f.startsWith(MOC_DIR + path.sep));
  const noteTitles = extractNoteTitlesFromVault(insightFiles);
  if (noteTitles.length === 0) {
    appendLog("Organize: no notes in vault, skipping.");
    return [];
  }

  const titleToMetadata = new Map<string, NoteMetadata>();
  const titleToPath = new Map<string, string>();
  for (const rel of insightFiles) {
    const title = path.basename(rel, ".md");
    titleToPath.set(title, rel);
    const meta = await getNoteMetadata(vaultPath, rel);
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

  if (noteTitles.length <= maxTitlesOrganize) {
    const mocs = await suggestMocs(llm, noteTitles, titleToMetadata, highGravityTitles, context);
    if (mocs.length === 0) {
      appendLog("Organize: no JSON in response.");
      return [];
    }
    return writeMocs(vaultPath, mocs, noteTitles, llm, "");
  }

  const index = await loadIndex(vaultPath);
  const titleToEmbedding = new Map<string, number[]>();
  for (const e of index.entries) {
    if (e.embedding && e.embedding.length > 0) titleToEmbedding.set(e.title, e.embedding);
  }
  const useEmbeddings = config.useEmbeddings ?? true;
  const embeddingClient = getEmbeddingClient();
  if (useEmbeddings && embeddingClient) {
    for (const title of noteTitles) {
      if (titleToEmbedding.has(title)) continue;
      const rel = titleToPath.get(title);
      if (!rel) continue;
      try {
        const raw = await readNote(vaultPath, rel);
        const snippet = raw.slice(0, 300);
        const emb = await embeddingClient.embed(`${title} ${snippet}`.slice(0, 8000));
        titleToEmbedding.set(title, emb);
        await indexNote(vaultPath, title, rel, snippet, emb);
      } catch {
        // skip this note for clustering
      }
    }
  }

  let clusters: string[][];
  if (titleToEmbedding.size === 0) {
    const chunkSize = maxTitlesOrganize;
    clusters = [];
    for (let i = 0; i < noteTitles.length; i += chunkSize) {
      clusters.push(noteTitles.slice(i, i + chunkSize));
    }
  } else {
    clusters = clusterByEmbedding(noteTitles, titleToEmbedding, 50);
  }
  const clusterContext =
    context +
    " This is one cluster of the vault; suggest MOCs that group these notes by theme.";
  const allCreated: string[] = [];
  for (let i = 0; i < clusters.length; i++) {
    const clusterTitles = clusters[i];
    const clusterHighGravity = highGravityTitles.filter((t) => clusterTitles.includes(t));
    const mocs = await suggestMocs(llm, clusterTitles, titleToMetadata, clusterHighGravity, clusterContext);
    const suffix = ` – Cluster ${i + 1}`;
    const created = await writeMocs(vaultPath, mocs, clusterTitles, llm, suffix);
    allCreated.push(...created);
  }
  return allCreated;
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
