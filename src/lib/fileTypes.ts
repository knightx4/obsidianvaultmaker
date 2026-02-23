/** File extensions the app can process (text + extractable office). */
export const TEXT_EXT = [".md", ".txt"];
export const OFFICE_EXT = [".pdf", ".docx", ".doc", ".pptx", ".ppt"];
export const ALLOWED_EXT = [...TEXT_EXT, ...OFFICE_EXT];

export function isAllowedExt(ext: string): boolean {
  return ALLOWED_EXT.includes(ext.toLowerCase());
}
