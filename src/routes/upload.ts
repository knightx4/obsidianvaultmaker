import { Router } from "express";
import multer from "multer";
import path from "path";
import { writeFile, mkdir } from "fs/promises";
import AdmZip from "adm-zip";
import { getAgentState } from "../agent/loop.js";
import { enqueueFileForProcessing } from "../agent/loop.js";
import { isExtractable, extractText } from "../extract/office.js";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });
export const uploadRouter = Router();

const TEXT_EXT = [".md", ".txt"];
const OFFICE_EXT = [".pdf", ".docx", ".doc", ".pptx", ".ppt"];
const ALLOWED_EXT = [...TEXT_EXT, ...OFFICE_EXT];
const UPLOAD_SUBDIR = "uploads";

function sanitizeRelative(rel: string): string {
  const normalized = path.normalize(rel).replace(/^(\.\.(\/|\\|$))+/, "");
  return normalized.split(path.sep).filter(Boolean).join(path.sep);
}

/** Write content to vault; return relative path to the written .md file for agent queue. */
async function writeFileAndGetRel(
  vaultPath: string,
  relPath: string,
  content: string | Buffer,
  encoding: BufferEncoding = "utf-8"
): Promise<string> {
  const full = path.join(vaultPath, sanitizeRelative(relPath));
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, content, encoding);
  return relPath;
}

uploadRouter.post("/files", upload.array("files", 50), async (req, res) => {
  const state = getAgentState();
  if (!state.vaultPath) {
    res.status(400).json({ ok: false, error: "Set vault path first" });
    return;
  }
  const files = req.files as Express.Multer.File[] | undefined;
  if (!files?.length) {
    res.status(400).json({ ok: false, error: "No files uploaded" });
    return;
  }
  const created: string[] = [];
  for (const f of files) {
    const ext = path.extname(f.originalname).toLowerCase();
    if (!ALLOWED_EXT.includes(ext)) continue;
    const baseName = (f.originalname || "unnamed").replace(/[/\\?%*:|"<>]/g, "-");
    const dir = UPLOAD_SUBDIR;
    if (isExtractable(ext)) {
      const text = await extractText(f.buffer);
      const mdName = path.basename(baseName, ext) + ".md";
      const rel = path.join(dir, mdName);
      await writeFileAndGetRel(state.vaultPath, rel, text || "(No text extracted.)", "utf-8");
      created.push(rel);
      enqueueFileForProcessing(rel);
    } else {
      const rel = path.join(dir, baseName);
      await writeFileAndGetRel(state.vaultPath, rel, f.buffer, "utf-8");
      created.push(rel);
      enqueueFileForProcessing(rel);
    }
  }
  res.json({ ok: true, created, count: created.length });
});

uploadRouter.post("/zip", upload.single("zip"), async (req, res) => {
  const state = getAgentState();
  if (!state.vaultPath) {
    res.status(400).json({ ok: false, error: "Set vault path first" });
    return;
  }
  const file = req.file;
  if (!file?.buffer) {
    res.status(400).json({ ok: false, error: "No ZIP file uploaded" });
    return;
  }
  const zip = new AdmZip(file.buffer);
  const entries = zip.getEntries();
  const created: string[] = [];
  for (const e of entries) {
    if (e.isDirectory) continue;
    let name = e.entryName.replace(/\\/g, "/");
    if (name.includes("..")) continue;
    name = sanitizeRelative(name);
    if (!name) continue;
    const ext = path.extname(name).toLowerCase();
    if (!ALLOWED_EXT.includes(ext)) continue;
    const data = e.getData();
    if (isExtractable(ext)) {
      const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      const text = await extractText(buffer);
      const mdName = path.basename(name, ext) + ".md";
      const rel = path.join(path.dirname(name), mdName);
      const full = path.join(state.vaultPath, sanitizeRelative(rel));
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, text || "(No text extracted.)", "utf-8");
      created.push(rel);
      enqueueFileForProcessing(rel);
    } else {
      const full = path.join(state.vaultPath, name);
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, data, "utf-8");
      created.push(name);
      enqueueFileForProcessing(name);
    }
  }
  res.json({ ok: true, created, count: created.length });
});
