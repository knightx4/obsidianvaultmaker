import { readFile, writeFile, mkdir } from "fs/promises";
import path from "path";
import matter from "gray-matter";
import type { LLMClient } from "../llm/client.js";
import { appendLog } from "./queue.js";
import { listMarkdownFiles, readNote } from "./link.js";
import { parseRelationshipLinksFromContent, stripMarkdownFences } from "./prompts.js";
import { loadAgentConfig } from "../storage/agentConfig.js";
import { indexNote } from "../retrieval/embeddingIndex.js";
import { getEmbeddingClient } from "../retrieval/retrieve.js";

const MOC_DIR = "MOCs";
const MOC_PREFIX = MOC_DIR + "/";
const VALIDATION_DIR = ".vaultmaker";
const CONFLICTS_SUBDIR = "Conflicts";
const EVIDENCE_RELATIONS = new Set(["Evidence for", "Supports"]);

export interface ValidationReport {
  conflicts: Array<{ fromTitle: string; toTitle: string }>;
  orphans: string[];
  synthesisNotesCreated: string[];
  lastUpdated: string;
}

/**
 * Load all insight notes (exclude MOCs), parse frontmatter and relationship links.
 */
async function loadVaultGraph(vaultPath: string): Promise<{
  titles: string[];
  typeByTitle: Map<string, string>;
  linksByTitle: Map<string, Array<{ relationship: string; title: string }>>;
}> {
  const files = await listMarkdownFiles(vaultPath);
  const insightFiles = files.filter(
    (f) => !f.startsWith(MOC_PREFIX) && !f.startsWith(MOC_DIR + path.sep) && f.endsWith(".md")
  );
  const titles = insightFiles.map((f) => path.basename(f, ".md"));
  const typeByTitle = new Map<string, string>();
  const linksByTitle = new Map<string, Array<{ relationship: string; title: string }>>();

  for (const rel of insightFiles) {
    const raw = await readNote(vaultPath, rel);
    const parsed = matter(raw);
    const title = path.basename(rel, ".md");
    const data = parsed.data as Record<string, unknown>;
    if (data && typeof data.type === "string") typeByTitle.set(title, data.type.trim());
    const links = parseRelationshipLinksFromContent((parsed.content ?? "").trim());
    linksByTitle.set(title, links);
  }
  return { titles, typeByTitle, linksByTitle };
}

/**
 * Find all pairs (from, to) where from has "Relationship:: Contradicts [[to]]".
 */
function findContradictions(
  linksByTitle: Map<string, Array<{ relationship: string; title: string }>>
): Array<{ fromTitle: string; toTitle: string }> {
  const pairs: Array<{ fromTitle: string; toTitle: string }> = [];
  for (const [fromTitle, links] of linksByTitle) {
    for (const { relationship, title } of links) {
      if (relationship === "Contradicts") {
        pairs.push({ fromTitle, toTitle: title });
      }
    }
  }
  return pairs;
}

/**
 * Find note titles with type Conclusion that have no incoming Evidence for or Supports.
 */
function findOrphans(
  titles: string[],
  typeByTitle: Map<string, string>,
  linksByTitle: Map<string, Array<{ relationship: string; title: string }>>
): string[] {
  const hasIncomingEvidence = new Set<string>();
  for (const [, links] of linksByTitle) {
    for (const { relationship, title } of links) {
      if (EVIDENCE_RELATIONS.has(relationship)) {
        hasIncomingEvidence.add(title);
      }
    }
  }
  return titles.filter(
    (t) => typeByTitle.get(t) === "Conclusion" && !hasIncomingEvidence.has(t)
  );
}

/**
 * Create a synthesis note for a contradiction pair. Does not fix data; documents tension.
 */
async function createSynthesisNote(
  llm: LLMClient,
  vaultPath: string,
  fromTitle: string,
  toTitle: string,
  existingTitles: Set<string>
): Promise<string | null> {
  const safeName = `Conflict-${fromTitle}-vs-${toTitle}`.replace(/[/\\?%*:|"<>]/g, "-").trim();
  if (existingTitles.has(safeName)) return null;

  const userPrompt = `Two notes contradict each other: "${fromTitle}" and "${toTitle}". Create a short synthesis note that documents this tension without resolving it. State both positions and that they conflict. Use links: Relationship:: Contradicts [[${fromTitle}]] and Relationship:: Contradicts [[${toTitle}]]. Output only the markdown body (no frontmatter).`;

  const raw = await llm.complete(
    [
      {
        role: "system",
        content:
          "You document logical conflicts between notes. Output only markdown. Do not fix or remove the contradiction; document it for human or AI review.",
      },
      { role: "user", content: userPrompt },
    ],
    { maxTokens: 512 }
  );

  const content = stripMarkdownFences(raw.trim());
  if (!content) return null;

  const frontmatter: Record<string, unknown> = {
    type: "Conflict",
    source: "validate",
  };
  const output = matter.stringify(content, frontmatter, {
    delimiters: ["---", "---"],
  });
  const dir = path.join(vaultPath, VALIDATION_DIR, CONFLICTS_SUBDIR);
  await mkdir(dir, { recursive: true });
  const rel = path.join(VALIDATION_DIR, CONFLICTS_SUBDIR, `${safeName}.md`);
  const full = path.join(vaultPath, rel);
  await writeFile(full, output, "utf-8");
  appendLog(`Validation: synthesis note ${rel}`);
  const snippet = content.slice(0, 300);
  let emb: number[] | undefined;
  const config = await loadAgentConfig(vaultPath);
  if (config.useEmbeddings !== false) {
    const ec = getEmbeddingClient();
    if (ec) {
      try {
        emb = await ec.embed(`${safeName} ${snippet}`.slice(0, 8000));
      } catch {
        // index without embedding
      }
    }
  }
  await indexNote(vaultPath, safeName, rel, snippet, emb);
  return rel;
}

/**
 * Run validation: conflict detection, synthesis notes for contradictions, orphan check.
 * Writes .vaultmaker/validation.json with the report.
 */
export async function runValidation(
  vaultPath: string,
  llm: LLMClient | null
): Promise<ValidationReport> {
  const { titles, typeByTitle, linksByTitle } = await loadVaultGraph(vaultPath);
  const conflicts = findContradictions(linksByTitle);
  const orphans = findOrphans(titles, typeByTitle, linksByTitle);

  const existingTitles = new Set(titles);
  const synthesisNotesCreated: string[] = [];

  if (llm) {
    const seen = new Set<string>();
    for (const { fromTitle, toTitle } of conflicts) {
      const key = [fromTitle, toTitle].sort().join(" vs ");
      if (seen.has(key)) continue;
      seen.add(key);
      const rel = await createSynthesisNote(
        llm,
        vaultPath,
        fromTitle,
        toTitle,
        existingTitles
      );
      if (rel) {
        synthesisNotesCreated.push(rel);
        existingTitles.add(path.basename(rel, ".md"));
      }
    }
  }

  const report: ValidationReport = {
    conflicts,
    orphans,
    synthesisNotesCreated,
    lastUpdated: new Date().toISOString(),
  };

  const reportPath = path.join(vaultPath, VALIDATION_DIR, "validation.json");
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2), "utf-8");
  appendLog(`Validation: report written to ${VALIDATION_DIR}/validation.json`);
  return report;
}
