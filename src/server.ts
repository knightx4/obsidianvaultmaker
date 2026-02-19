import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import { createOpenAIClient } from "./llm/openai.js";
import { setLLM } from "./agent/loop.js";
import { vaultRouter } from "./routes/vault.js";
import { uploadRouter } from "./routes/upload.js";
import { agentRouter } from "./routes/agent.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3840;

const apiKey = process.env.OPENAI_API_KEY;
if (apiKey) {
  setLLM(createOpenAIClient(apiKey));
}

const app = express();
app.use(cors());
app.use(express.json());

app.use("/api/vault", vaultRouter);
app.use("/api/upload", uploadRouter);
app.use("/api/agent", agentRouter);

const publicDir = path.join(__dirname, "..", "public");
app.use(express.static(publicDir));
app.get("*", (_req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

app.listen(PORT, () => {
  console.log(`Vault Builder Agent at http://localhost:${PORT}`);
});
