# Vault Builder Agent

Builds an **insight-only** Obsidian vault from your sources. The agent reads each document (or folder), extracts key insights and ideas, and writes only those as linked notes—no raw files in the vault.

## Run

1. `npm install` (from this folder, or from repo root run `npm run install:app`)
2. Copy `.env.example` to `.env` and set `OPENAI_API_KEY`
3. `npm run dev` — server runs at http://localhost:3840 (from this folder or from repo root)

## Usage

1. **Vault**: Set the vault path (where the **insight** vault will live). No raw files are written here—only insight notes.
2. **Upload / Import**: Add files or a ZIP, or use *Import from folder* to point at a folder. Source text is staged; the agent will extract insights from each source.
3. **Agent**: Click *Start agent*. It processes each source, writes insight notes under `Insights/`, and links them. You can stop or let it run; it can keep linking and refining.

## Tech

- Node + TypeScript, Express, multer, adm-zip, officeparser (PDF/Word/PowerPoint text extraction), OpenAI.
- Sources are stored in `data/sources/` (staging); the vault contains only `Insights/*.md` and their `[[links]]`.
