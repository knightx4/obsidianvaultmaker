/**
 * Shared scientific reasoning principles for all vault agents.
 * Prepend to system prompts in insights, link, split, and organize.
 */
export const SCIENTIFIC_REASONING_PRINCIPLES = `Scientific Method principles:
- **Precision:** Use consistent terminology across all notes.
- **Claim vs. Evidence:** Every claim must cite a source file or a parent note.
- **Falsifiability:** State what would make a conclusion incorrect (Assumptions).
- **Strict Linking:** Only link if the relationship is nameable (e.g., Supports, Contradicts, Requires).`;

/**
 * Relationship taxonomy for machine-readable links.
 * Use these exact strings in frontmatter or inline (e.g. "Relationship:: Supports [[Note]]").
 */
export const RELATIONSHIP_TAXONOMY = [
  "Supports",
  "Contradicts",
  "Requires",
  "Evidence for",
  "Evidence against",
  "Assumption of",
  "Conclusion of",
] as const;

export type RelationshipType = (typeof RELATIONSHIP_TAXONOMY)[number];

export const RELATIONSHIP_INLINE_REGEX =
  /Relationship::\s*([^\n[\]]+?)\s*\[\[([^\]]+)\]\]/g;

/**
 * Parse "Relationship:: Type [[Note Title]]" links from note content.
 * Returns array of { relationship, title } for graph/validation use.
 */
export function parseRelationshipLinksFromContent(
  content: string
): Array<{ relationship: string; title: string }> {
  const out: Array<{ relationship: string; title: string }> = [];
  let m: RegExpExecArray | null;
  const re = /Relationship::\s*([^\n[\]]+?)\s*\[\[([^\]]+)\]\]/g;
  while ((m = re.exec(content)) !== null) {
    out.push({ relationship: m[1].trim(), title: m[2].trim() });
  }
  return out;
}
