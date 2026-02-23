import dotenv from "dotenv";
import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import { existsSync, accessSync } from "fs";
import { createOpenAIClient } from "./llm/openai.js";
import { setLLM, setAgentVault, setSourceDir } from "./agent/loop.js";
import { loadVaultConfig } from "./storage/vaultConfig.js";
import { startSourceWatcher } from "./watcher/sourceWatcher.js";
import { vaultRouter } from "./routes/vault.js";
import { uploadRouter } from "./routes/upload.js";
import { agentRouter } from "./routes/agent.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function findPublicDir(startDir: string): string {
  const candidates = [
    path.resolve(startDir, "..", "public"),
    path.resolve(startDir, "..", "obsidianvaultmaker", "public"),
  ];
  for (const dir of candidates) {
    if (existsSync(path.join(dir, "index.html"))) return dir;
  }
  return path.resolve(startDir, "..", "public");
}

function findEnvPath(startDir: string): string {
  const candidates = [
    path.resolve(startDir, "..", ".env"),
    path.resolve(startDir, "..", "obsidianvaultmaker", ".env"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return path.resolve(startDir, "..", ".env");
}

dotenv.config({ path: findEnvPath(__dirname) });
const publicDir = findPublicDir(__dirname);
const PORT = Number(process.env.PORT) || 3840;

const apiKey = process.env.OPENAI_API_KEY;
if (apiKey) {
  setLLM(createOpenAIClient(apiKey));
} else {
  console.warn("OPENAI_API_KEY is not set. Add it to the .env file in the app folder to use the agent.");
}

const app = express();
app.use(cors());
app.use(express.json());

app.use("/api/vault", vaultRouter);
app.use("/api/upload", uploadRouter);
app.use("/api/agent", agentRouter);

app.use(express.static(publicDir));
app.get("*", (_req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

app.listen(PORT, async () => {
  console.log(`Vault Builder Agent at http://localhost:${PORT}`);
  const config = await loadVaultConfig();
  if (config.vaultPath) {
    await setAgentVault(config.vaultPath, config.vaultName);
    setSourceDir(config.sourceDir);
    if (config.sourceDir) {
      try {
        accessSync(config.sourceDir);
        startSourceWatcher(config.sourceDir, config.vaultPath);
      } catch {
        // source folder not accessible
      }
    }
  }
});
