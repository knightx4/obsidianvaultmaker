import matter from "gray-matter";

const SECTION_HEADING = "## Relations (auto)";

/**
 * Append or replace the auto relations section without rewriting the rest of the note.
 */
export function applyRelationsSection(fullMarkdown: string, relationshipLines: string[]): string {
  const parsed = matter(fullMarkdown);
  let body = (parsed.content ?? "").trimEnd();
  const data = parsed.data;

  // Remove existing auto section (from heading to end of body)
  const sectionRe = /\n?## Relations \(auto\)[\s\S]*$/;
  body = body.replace(sectionRe, "").trimEnd();

  if (relationshipLines.length === 0) {
    return matter.stringify(body, data, { delimiters: ["---", "---"] });
  }

  const lines = relationshipLines
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => (l.startsWith("-") ? l : `- ${l}`));

  const block = [body, "", SECTION_HEADING, "", ...lines].join("\n");
  return matter.stringify(block, data, { delimiters: ["---", "---"] });
}
