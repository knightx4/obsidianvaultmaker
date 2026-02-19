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

const ZIP_MAGIC = Buffer.from([0x50, 0x4b]);

function isZip(buffer: Buffer, filename: string): boolean {
  if (buffer.length >= 2 && buffer[0] === ZIP_MAGIC[0] && buffer[1] === ZIP_MAGIC[1]) return true;
  return path.extname(filename).toLowerCase() === ".zip";
}

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

async function processZipBuffer(vaultPath: string, buffer: Buffer): Promise<string[]> {
  const created: string[] = [];
  const zip = new AdmZip(buffer);
  const entries = zip.getEntries();
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
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      const text = await extractText(buf);
      const mdName = path.basename(name, ext) + ".md";
      const rel = path.join(path.dirname(name), mdName);
      const full = path.join(vaultPath, sanitizeRelative(rel));
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, text || "(No text extracted.)", "utf-8");
      created.push(rel);
      enqueueFileForProcessing(rel);
    } else {
      const full = path.join(vaultPath, name);
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, data, "utf-8");
      created.push(name);
      enqueueFileForProcessing(name);
    }
  }
  return created;
}

async function processOneFile(
  vaultPath: string,
  f: Express.Multer.File
): Promise<string[]> {
  const created: string[] = [];
  const ext = path.extname(f.originalname).toLowerCase();
  if (!ALLOWED_EXT.includes(ext)) return created;
  const baseName = (f.originalname || "unnamed").replace(/[/\\?%*:|"<>]/g, "-");
  const dir = UPLOAD_SUBDIR;
  if (isExtractable(ext)) {
    const text = await extractText(f.buffer);
    const mdName = path.basename(baseName, ext) + ".md";
    const rel = path.join(dir, mdName);
    await writeFileAndGetRel(vaultPath, rel, text || "(No text extracted.)", "utf-8");
    created.push(rel);
    enqueueFileForProcessing(rel);
  } else {
    const rel = path.join(dir, baseName);
    await writeFileAndGetRel(vaultPath, rel, f.buffer, "utf-8");
    created.push(rel);
    enqueueFileForProcessing(rel);
  }
  return created;
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
    if (isZip(f.buffer, f.originalname || "")) {
      const fromZip = await processZipBuffer(state.vaultPath, f.buffer);
      created.push(...fromZip);
    } else {
      const fromFile = await processOneFile(state.vaultPath, f);
      created.push(...fromFile);
    }
  }
  res.json({ ok: true, created, count: created.length });
});
