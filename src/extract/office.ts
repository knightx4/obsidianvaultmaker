/**
 * Extract plain text from PDF, Word (.docx), and PowerPoint (.pptx) for vault analysis.
 */
import { parseOffice } from "officeparser";

const EXTRACTABLE_EXT = [".pdf", ".docx", ".doc", ".pptx", ".ppt"];

export function isExtractable(ext: string): boolean {
  return EXTRACTABLE_EXT.includes(ext.toLowerCase());
}

/**
 * Returns plain text from the document buffer, or null if extraction fails.
 */
export async function extractText(buffer: Buffer): Promise<string | null> {
  try {
    const ast = await parseOffice(buffer);
    const text = typeof ast.toText === "function" ? ast.toText() : "";
    return (text && text.trim()) || null;
  } catch {
    return null;
  }
}

export { EXTRACTABLE_EXT };
