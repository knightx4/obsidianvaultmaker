import { writeFile, mkdir } from "fs/promises";
import path from "path";
import matter from "gray-matter";
import type { LLMClient } from "../llm/client.js";
import { appendLog } from "./queue.js";
import { listMarkdownFiles, extractNoteTitlesFromVault } from "./link.js";
import {
  SCIENTIFIC_REASONING_PRINCIPLES,
  RELATIONSHIP_TAXONOMY,
} from "./prompts.js";

const INSIGHTS_DIR = "Insights";

const SYSTEM_PROMPT = `${SCIENTIFIC_REASONING_PRINCIPLES}

You are building an Obsidian insight vault. Your job is to read source text and extract only the key insights, ideas, and concepts—not to copy or paraphrase the whole text.

Rules:
- Output only valid markdown. Use Obsidian wiki links: [[Note Title]] to connect related insights (use exact titles from "Existing insight notes" when linking).
- For every link, use machine-readable relationship format: "Relationship:: <type> [[Note Title]]" on its own line or in a sentence. Allowed types: ${RELATIONSHIP_TAXONOMY.join(", ")}.
- Create one note per distinct insight or idea. Each note should be concise and atomic. Titles should be clear, reusable claims.
- Do not dump raw content. Extract and name the insight clearly. Link to other insights (from this source or existing notes) only when there is a nameable relationship.
- When useful, include **Implication:** or **Depends on:** or **Assumptions:** (what would make this wrong) in the body.
- **type** must be one of: Observation, Claim, Evidence, Method (or Conclusion, Theme when appropriate). Adapt to domain.
- **confidence** must be a number between 0.0 and 1.0 (e.g. 0.9). Not high/medium/low.
- **tags** (optional): array of single-word or hyphenated strings (no spaces). When in doubt, prefer fewer, sharper notes over many vague ones.`;

export interface ExtractedInsight {
  title: string;
  content: string;
  type?: string;
  confidence?: number;
  importance?: string;
  source?: string;
  tags?: string[];
  [key: string]: unknown;
}

const MAX_CHUNK = 12000;

/**
 * Extract insight notes from a source text. Writes only insight .md files to the vault (under Insights/).
 * Returns relative paths of created notes.
 */
export async function extractInsightsFromSource(
  llm: LLMClient,
  vaultPath: string,
  sourceText: string,
  sourceName: string,
  existingTitles: string[]
): Promise<string[]> {
  await mkdir(vaultPath, { recursive: true });
  const created: string[] = [];
  const chunks = chunkText(sourceText, MAX_CHUNK);
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const userPrompt = `Source: ${sourceName}${chunks.length > 1 ? ` (part ${i + 1}/${chunks.length})` : ""}

\`\`\`
${chunk}
\`\`\`

Existing insight notes in the vault (use these exact titles in [[links]] when an insight relates):
${existingTitles.length ? existingTitles.map((t) => `- ${t}`).join("\n") : "(none yet)"}

Extract the key insights from this text. For each insight, provide:
- \`title\`: short, clear claim
- \`content\`: concise markdown body. For any link to another note use the format "Relationship:: <type> [[Exact Note Title]]" (e.g. "Relationship:: Evidence for [[Note Title]]"). Allowed relationship types: ${RELATIONSHIP_TAXONOMY.join(", ")}. Include **Assumptions:** when relevant (what would make this wrong).
- \`type\`: one of Observation, Claim, Evidence, Method (or Conclusion, Theme when it is a conclusion or theme). Required.
- \`confidence\`: number between 0.0 and 1.0 (e.g. 0.85). Required for Claim and Conclusion.
- \`importance\` (optional): e.g. critical, high, medium, low
- \`tags\` (optional): array of single-word or hyphenated strings (no spaces)

Output only a JSON object, no other text:
{"insights": [{"title": "Note Title", "content": "markdown with Relationship:: Type [[Links]]", "type": "Claim", "confidence": 0.9, "tags": ["strategy"]}]}`;

    const raw = await llm.complete(
      [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      { maxTokens: 4096 }
    );

    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      appendLog(`Insights: no JSON in response for ${sourceName}`);
      continue;
    }
    let parsed: { insights?: ExtractedInsight[] };
    try {
      parsed = JSON.parse(jsonMatch[0]) as { insights?: ExtractedInsight[] };
    } catch {
      appendLog(`Insights: invalid JSON for ${sourceName}`);
      continue;
    }
    const insights = Array.isArray(parsed.insights) ? parsed.insights : [];
    for (const note of insights) {
      if (!note.title || !note.content?.trim()) continue;
      const safeTitle = note.title.replace(/[/\\?%*:|"<>]/g, "-").trim() || "Untitled";
      const frontmatter = buildObsidianProperties(note, sourceName);
      const body = note.content.trim();
      const output = matter.stringify(body, frontmatter, { delimiters: ["---", "---"] });
      const rel = path.join(INSIGHTS_DIR, `${safeTitle}.md`);
      const full = path.join(vaultPath, rel);
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, output, "utf-8");
      created.push(rel);
      existingTitles.push(safeTitle);
      appendLog(`Insight: ${rel}`);
    }
  }
  return created;
}

/** Build Obsidian properties (flat YAML) from extracted insight. Only include non-empty values. */
function buildObsidianProperties(note: ExtractedInsight, sourceName: string): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  if (note.type && String(note.type).trim()) props.type = String(note.type).trim();
  const conf = note.confidence;
  if (typeof conf === "number" && conf >= 0 && conf <= 1) props.confidence = conf;
  else if (typeof conf === "string") {
    const n = parseFloat(conf);
    if (!Number.isNaN(n) && n >= 0 && n <= 1) props.confidence = n;
  }
  if (note.importance && String(note.importance).trim()) props.importance = String(note.importance).trim();
  props.source = sourceName;
  const tagsFiltered = Array.isArray(note.tags)
    ? note.tags
        .filter((t) => typeof t === "string" && t.trim())
        .map((t) => t.trim().replace(/\s+/g, "-"))
    : [];
  if (tagsFiltered.length > 0) props.tags = tagsFiltered;
  return props;
}

function chunkText(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + maxLen, text.length);
    if (end < text.length) {
      const lastBreak = text.lastIndexOf("\n\n", end);
      if (lastBreak > start) end = lastBreak + 2;
    }
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}

export async function getExistingInsightTitles(vaultPath: string): Promise<string[]> {
  const files = await listMarkdownFiles(vaultPath);
  return extractNoteTitlesFromVault(files);
}
