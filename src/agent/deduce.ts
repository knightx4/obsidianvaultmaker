import { writeFile, mkdir } from "fs/promises";
import path from "path";
import matter from "gray-matter";
import type { LLMClient } from "../llm/client.js";
import { appendLog } from "./queue.js";
import {
  listMarkdownFiles,
  readNote,
  extractNoteTitlesFromVault,
} from "./link.js";
import { parseRelationshipLinksFromContent } from "./prompts.js";

const INSIGHTS_DIR = "Insights";
const MOC_DIR = "MOCs";
const MOC_PREFIX = MOC_DIR + "/";

/** Relationship types that indicate "premise supports/concludes to target" */
const PREMISE_RELATIONS = new Set(["Evidence for", "Supports", "Requires"]);

const DEDUCE_SYSTEM_PROMPT = `You are the deductive agent. Given linked premises and optionally a current conclusion note, infer the unspoken conclusion only if it is new and non-obvious.

Rules:
- Create ZERO notes if no new logical conclusion can be drawn. Do not create Tautology Notes (simply restating the input).
- Only output a new conclusion when it clearly follows from the premises and is not already stated in the vault.
- If you output a conclusion, use exact format: one note with "title" and "content". In content use "Relationship:: Conclusion of [[Premise Title]]" for each premise. Set type to Conclusion.
- Output only valid JSON: {"conclusion": null} when no new conclusion, or {"conclusion": {"title": "...", "content": "markdown with Relationship:: Conclusion of [[...]] links"}}. No other text.`;

/**
 * Build a reverse index: for each note title, list { path, relationship } of notes that link TO it with Evidence for / Supports / Requires.
 */
async function buildReverseLinkIndex(
  vaultPath: string,
  insightFiles: string[]
): Promise<Map<string, Array<{ fromPath: string; fromTitle: string; relationship: string }>>> {
  const index = new Map<string, Array<{ fromPath: string; fromTitle: string; relationship: string }>>();
  for (const relPath of insightFiles) {
    const raw = await readNote(vaultPath, relPath);
    const parsed = matter(raw);
    const body = (parsed.content ?? "").trim();
    const fromTitle = path.basename(relPath, ".md");
    const links = parseRelationshipLinksFromContent(body);
    for (const { relationship, title } of links) {
      if (!PREMISE_RELATIONS.has(relationship)) continue;
      const key = title.trim();
      if (!key) continue;
      let list = index.get(key);
      if (!list) {
        list = [];
        index.set(key, list);
      }
      list.push({ fromPath: relPath, fromTitle, relationship });
    }
  }
  return index;
}

/**
 * Run deductive step for one note: find premises that link to it, ask LLM for unspoken conclusion, write new note only if valid.
 */
export async function runDeduceForNote(
  llm: LLMClient,
  vaultPath: string,
  relativePath: string,
  allInsightTitles: Set<string>
): Promise<string | null> {
  const raw = await readNote(vaultPath, relativePath);
  const parsed = matter(raw);
  const body = (parsed.content ?? "").trim();
  const currentTitle = path.basename(relativePath, ".md");

  const files = await listMarkdownFiles(vaultPath);
  const insightFiles = files.filter(
    (f) => !f.startsWith(MOC_PREFIX) && f.endsWith(".md")
  );
  const reverseIndex = await buildReverseLinkIndex(vaultPath, insightFiles);
  const premises = reverseIndex.get(currentTitle);
  if (!premises || premises.length === 0) return null;

  const premiseTitles = [...new Set(premises.map((p) => p.fromTitle))];
  const premiseBodies: string[] = [];
  for (const t of premiseTitles) {
    const f = insightFiles.find((p) => path.basename(p, ".md") === t);
    if (f) {
      const r = await readNote(vaultPath, f);
      const p = matter(r);
      premiseBodies.push(`## ${t}\n${(p.content ?? "").trim()}`);
    }
  }

  const userPrompt = `Premises (these link to "${currentTitle}" with Evidence for / Supports):
${premiseBodies.join("\n\n")}

Current note ("${currentTitle}"):
${body}

Existing note titles in vault (do not create a note that restates or duplicates these): ${[...allInsightTitles].slice(0, 200).join(", ")}

Given these linked premises, what is the unspoken conclusion? If the conclusion is already stated above or is a tautology, return {"conclusion": null}. Otherwise return {"conclusion": {"title": "Conclusion Title", "content": "markdown with Relationship:: Conclusion of [[Premise Note Title]] for each premise"}}.`;

  const response = await llm.complete(
    [
      { role: "system", content: DEDUCE_SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    { maxTokens: 1024 }
  );

  const jsonMatch = response.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  let parsedOut: { conclusion?: { title: string; content: string } | null };
  try {
    parsedOut = JSON.parse(jsonMatch[0]) as {
      conclusion?: { title: string; content: string } | null;
    };
  } catch {
    return null;
  }
  const conclusion = parsedOut.conclusion;
  if (!conclusion || !conclusion.title || !conclusion.content?.trim()) return null;

  const newTitle = conclusion.title.replace(/[/\\?%*:|"<>]/g, "-").trim() || "Untitled";
  if (allInsightTitles.has(newTitle)) return null;

  const content = conclusion.content.trim();
  const frontmatter: Record<string, unknown> = {
    type: "Conclusion",
    source: "deduce",
  };
  const output = matter.stringify(content, frontmatter, {
    delimiters: ["---", "---"],
  });
  const newRel = path.join(INSIGHTS_DIR, `${newTitle}.md`);
  const fullPath = path.join(vaultPath, newRel);
  await mkdir(path.dirname(fullPath), { recursive: true });
  await writeFile(fullPath, output, "utf-8");
  appendLog(`Deduce: ${newRel}`);
  return newRel;
}
