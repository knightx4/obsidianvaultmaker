import { writeFile, mkdir } from "fs/promises";
import path from "path";
import matter from "gray-matter";
import { randomUUID } from "crypto";
import type { LLMClient } from "../llm/client.js";
import { appendLog } from "./queue.js";
import { listMarkdownFiles, extractNoteTitlesFromVault } from "./link.js";
import {
  SCIENTIFIC_REASONING_PRINCIPLES,
  RELATIONSHIP_TAXONOMY,
  stripMarkdownFences,
} from "./prompts.js";
import { loadAgentConfig } from "../storage/agentConfig.js";
import { loadIndex, indexNote } from "../retrieval/embeddingIndex.js";
import { getRelevantTitles, getEmbeddingClient, similarity } from "../retrieval/retrieve.js";
import { saveChunksForSource, type TextChunk } from "../chunks/chunkSource.js";
import { ensureChunkEmbeddings } from "../retrieval/chunkEmbeddings.js";
import type { ExtractedAtomPayload, EvidenceRef } from "./atomTypes.js";
import {
  mergeSourcesAndChunks,
  upsertAtomsBatch,
  type AtomRecord,
  type SourceRef,
  type ChunkRef,
} from "../storage/atomsStore.js";
import { getVaultmakerVersion } from "../storage/manifest.js";
import { getRunContext } from "./runContext.js";
import { appendDraftAtoms } from "../storage/draft.js";

const INSIGHTS_DIR = "Insights";

const SYSTEM_PROMPT = `${SCIENTIFIC_REASONING_PRINCIPLES}

You are building an Obsidian insight vault. Your job is to read source text and extract only the key insights, ideas, and concepts—not to copy or paraphrase the whole text.

Rules:
- Output only valid markdown in each insight's content field. Use Obsidian wiki links: [[Note Title]] to connect related insights (use exact titles from "Existing insight notes" when linking).
- For every link, use machine-readable relationship format: "Relationship:: <type> [[Note Title]]" on its own line or in a sentence. Allowed types: ${RELATIONSHIP_TAXONOMY.join(", ")}.
- Create one note per distinct insight or idea. Each note should be concise and atomic. Titles should be clear, reusable claims.
- Do not dump raw content. Extract and name the insight clearly. Link to other insights only when there is a nameable relationship.
- When useful, include **Implication:** or **Depends on:** or **Assumptions:** (what would make this wrong) in the body.
- **type** must be one of: Observation, Claim, Evidence, Method (or Conclusion, Theme when appropriate). Adapt to domain.
- **confidence** must be a number between 0.0 and 1.0 (e.g. 0.9). Not high/medium/low.
- **tags** (optional): array of single-word or hyphenated strings (no spaces). When in doubt, prefer fewer, sharper notes over many vague ones.
- **evidenceRefs** (required in agent mode): for each insight, cite supporting text with chunkId (exactly as given), start and end as character offsets within that chunk's text (0-based, end exclusive). Include a short quote when possible.`;

function mapTypeToKind(type: string | undefined): AtomRecord["kind"] {
  const t = (type ?? "").trim().toLowerCase();
  if (t === "claim") return "claim";
  if (t === "evidence") return "evidence";
  if (t === "observation") return "observation";
  if (t === "method") return "method";
  if (t === "theme") return "theme";
  if (t === "conclusion") return "conclusion";
  return "other";
}

function normalizeEvidenceRefs(
  refs: unknown,
  chunk: TextChunk,
  require: boolean
): EvidenceRef[] | null {
  if (!Array.isArray(refs)) {
    return require ? null : [];
  }
  const out: EvidenceRef[] = [];
  for (const r of refs) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const chunkId = typeof o.chunkId === "string" ? o.chunkId : "";
    const start = typeof o.start === "number" ? o.start : parseInt(String(o.start), 10);
    const end = typeof o.end === "number" ? o.end : parseInt(String(o.end), 10);
    const quote = typeof o.quote === "string" ? o.quote : undefined;
    if (chunkId !== chunk.chunkId || Number.isNaN(start) || Number.isNaN(end) || start < 0 || end > chunk.text.length || start >= end) {
      if (require) return null;
      continue;
    }
    out.push({ chunkId, start, end, quote });
  }
  if (require && out.length === 0) return null;
  return out;
}

function semanticDedupKey(sourceId: string, refs: EvidenceRef[]): string {
  if (refs.length === 0) return `${sourceId}:none`;
  const primary = refs[0]!;
  return `${sourceId}:${primary.chunkId}:${primary.start}:${primary.end}`;
}

/**
 * Extract insight notes from a source. Uses stable chunks on disk under .vaultmaker/chunks/.
 */
export async function extractInsightsFromSource(
  llm: LLMClient,
  vaultPath: string,
  sourceText: string,
  sourceName: string,
  sourceId: string,
  sourceRelPath?: string
): Promise<string[]> {
  await mkdir(vaultPath, { recursive: true });
  const config = await loadAgentConfig(vaultPath);
  const maxTitlesExtract = config.maxTitlesExtract;
  const dedupThreshold = config.dedupSimilarityThreshold;
  const useEmbeddings = config.useEmbeddings;
  const maxChunkChars = config.maxChunkChars;
  const requireEvidence =
    config.requireEvidenceRefs || config.agentMode === "agent";
  const { dryRun } = getRunContext();

  const chunks = await saveChunksForSource(vaultPath, sourceId, sourceText, maxChunkChars);
  const embeddingClient = getEmbeddingClient();
  await ensureChunkEmbeddings(
    vaultPath,
    chunks.map((c) => ({ chunkId: c.chunkId, sourceId: c.sourceId, text: c.text })),
    embeddingClient,
    useEmbeddings
  );

  const sourceRef: SourceRef = {
    id: sourceId,
    path: sourceRelPath ?? sourceName,
    name: sourceName,
  };
  const chunkRefs: ChunkRef[] = chunks.map((c) => ({
    chunkId: c.chunkId,
    sourceId: c.sourceId,
    startOffset: c.startOffset,
    endOffset: c.endOffset,
  }));
  await mergeSourcesAndChunks(vaultPath, [sourceRef], chunkRefs);

  const allMd = await listMarkdownFiles(vaultPath);
  const existingTitlesSet = new Set(extractNoteTitlesFromVault(allMd));
  let index = await loadIndex(vaultPath);

  const seenSemanticKeys = new Set<string>();
  const created: string[] = [];
  const atomBatch: AtomRecord[] = [];
  const pipelineVersion = getVaultmakerVersion();
  const extractedAt = new Date().toISOString();

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]!;
    const chunkPreview = chunk.text.slice(0, 500);
    const relevantTitles = await getRelevantTitles(vaultPath, chunkPreview, {
      limit: maxTitlesExtract,
      useEmbeddings,
    });
    const existingList = relevantTitles.length ? relevantTitles.map((t) => `- ${t}`).join("\n") : "(none yet)";

    const evidenceInstr = requireEvidence
      ? `Each insight MUST include evidenceRefs: [{"chunkId":"${chunk.chunkId}","start":0,"end":50,"quote":"..."}] with start/end within this chunk's text (length ${chunk.text.length}). Use chunkId exactly "${chunk.chunkId}".`
      : `When possible include evidenceRefs with chunkId "${chunk.chunkId}" and start/end offsets within this chunk.`;

    const userPrompt = `Source: ${sourceName} (source_id: ${sourceId})
Chunk ${i + 1}/${chunks.length} — chunk_id: ${chunk.chunkId}

\`\`\`
${chunk.text}
\`\`\`

Existing insight notes in the vault (use these exact titles in [[links]] when an insight relates):
${existingList}

${evidenceInstr}

Extract the key insights from this chunk. For each insight, provide:
- \`title\`: short, clear claim
- \`content\`: concise markdown body with Relationship:: lines when linking. Allowed relationship types: ${RELATIONSHIP_TAXONOMY.join(", ")}.
- \`type\`: one of Observation, Claim, Evidence, Method (or Conclusion, Theme when appropriate). Required.
- \`confidence\`: number between 0.0 and 1.0 for Claim and Conclusion.
- \`importance\` (optional)
- \`tags\` (optional)
- \`evidenceRefs\`: array of { chunkId, start, end, quote? } — ${requireEvidence ? "required" : "optional"}

Output only a JSON object, no other text:
{"insights": [{"title": "...", "content": "...", "type": "Claim", "confidence": 0.9, "evidenceRefs": [{"chunkId": "${chunk.chunkId}", "start": 0, "end": 120, "quote": "..."}]}]}`;

    const raw = await llm.complete(
      [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: userPrompt }],
      { maxTokens: 4096 }
    );

    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      appendLog(`Insights: no JSON in response for ${sourceName} chunk ${chunk.chunkId}`);
      continue;
    }
    let parsed: { insights?: ExtractedAtomPayload[] };
    try {
      parsed = JSON.parse(jsonMatch[0]) as { insights?: ExtractedAtomPayload[] };
    } catch {
      appendLog(`Insights: invalid JSON for ${sourceName}`);
      continue;
    }
    const insights = Array.isArray(parsed.insights) ? parsed.insights : [];

    for (const note of insights) {
      if (!note.title || !note.content?.trim()) continue;
      const safeTitle = note.title.replace(/[/\\?%*:|"<>]/g, "-").trim() || "Untitled";

      if (existingTitlesSet.has(safeTitle)) continue;

      const evidenceRefs = normalizeEvidenceRefs(note.evidenceRefs, chunk, requireEvidence);
      if (evidenceRefs === null) {
        appendLog(`Insights: skip "${safeTitle}" — invalid or missing evidenceRefs`);
        continue;
      }

      const dedupKey = semanticDedupKey(sourceId, evidenceRefs);
      if (seenSemanticKeys.has(dedupKey)) continue;
      seenSemanticKeys.add(dedupKey);

      if (useEmbeddings && embeddingClient && index.entries.some((e) => e.embedding && e.embedding.length > 0)) {
        try {
          const toEmbed = `${note.title} ${note.content.trim().slice(0, 200)}`;
          const newEmbedding = await embeddingClient.embed(toEmbed.slice(0, 8000));
          let maxSim = 0;
          for (const e of index.entries) {
            if (e.embedding && e.embedding.length > 0) {
              const s = similarity(newEmbedding, e.embedding);
              if (s > maxSim) maxSim = s;
            }
          }
          if (maxSim >= dedupThreshold) continue;
        } catch {
          // proceed
        }
      }

      const atomId = randomUUID();
      const frontmatter = buildObsidianProperties(note, sourceName, {
        atomId,
        sourceId,
        chunkIds: [chunk.chunkId],
        pipelineVersion,
        extractedAt,
      });
      const body = stripMarkdownFences(note.content.trim());
      const output = matter.stringify(body, frontmatter, { delimiters: ["---", "---"] });
      const rel = path.join(INSIGHTS_DIR, `${safeTitle}.md`);
      const full = path.join(vaultPath, rel);

      if (!dryRun) {
        await mkdir(path.dirname(full), { recursive: true });
        await writeFile(full, output, "utf-8");
        created.push(rel);
        existingTitlesSet.add(safeTitle);
        appendLog(`Insight: ${rel}`);

        const bodySnippet = body.slice(0, 300);
        let emb: number[] | undefined;
        if (useEmbeddings && embeddingClient) {
          try {
            emb = await embeddingClient.embed(`${safeTitle} ${bodySnippet}`.slice(0, 8000));
          } catch {
            // index without embedding
          }
        }
        await indexNote(vaultPath, safeTitle, rel, bodySnippet, emb);
        index = await loadIndex(vaultPath);
      } else {
        appendLog(`Dry-run: would write ${rel}`);
        created.push(`(dry-run) ${rel}`);
      }

      atomBatch.push({
        atomId,
        kind: mapTypeToKind(note.type),
        title: safeTitle,
        type: note.type ? String(note.type).trim() : undefined,
        path: rel,
        sourceId,
        source: sourceRelPath ?? sourceName,
        chunkIds: [chunk.chunkId],
        evidenceRefs,
        provenance: "extracted",
        extractedAt,
        pipelineVersion,
      });
    }
  }

  if (atomBatch.length > 0) {
    if (dryRun) {
      const { runId } = getRunContext();
      if (runId) await appendDraftAtoms(vaultPath, runId, atomBatch);
    } else {
      await upsertAtomsBatch(vaultPath, atomBatch);
    }
  }

  return created;
}

function buildObsidianProperties(
  note: ExtractedAtomPayload,
  sourceName: string,
  extra: {
    atomId: string;
    sourceId: string;
    chunkIds: string[];
    pipelineVersion: string;
    extractedAt: string;
  }
): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  props.atom_id = extra.atomId;
  props.source_id = extra.sourceId;
  props.chunk_ids = extra.chunkIds;
  props.pipeline_version = extra.pipelineVersion;
  props.extracted_at = extra.extractedAt;

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

export async function getExistingInsightTitles(vaultPath: string): Promise<string[]> {
  const files = await listMarkdownFiles(vaultPath);
  return extractNoteTitlesFromVault(files);
}
