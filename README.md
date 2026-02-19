# Vault Builder Agent

Builds an Obsidian vault from uploaded files: breaks content into atomic notes and adds `[[links]]` between related ideas.

## Run

1. `npm install` (from this folder, or from repo root run `npm run install:app`)
2. Copy `.env.example` to `.env` and set `OPENAI_API_KEY`
3. `npm run dev` — server runs at http://localhost:3840 (from this folder or from repo root)

## Usage

1. **Vault**: Enter a vault name and the full path to your vault folder (e.g. `/Users/you/Documents/MyVault`). Click *Save vault config*.
2. **Upload**: Add `.md`, `.txt`, `.pdf`, Word (`.docx`/`.doc`), or PowerPoint (`.pptx`/`.ppt`) files, or upload a ZIP that preserves folder structure. PDF/Word/PowerPoint are converted to plain text and saved as `.md` for the agent to analyze.
3. **Agent**: Click *Start agent*. It will split notes into atomic concepts and add links. Use *Stop agent* to pause. Status and a short log update every few seconds.

## Tech

- Node + TypeScript, Express, multer (uploads), adm-zip (ZIP), officeparser (PDF/Word/PowerPoint text extraction), OpenAI.
- Agent: in-memory queue, split pass (LLM) + link pass (LLM); one note per task so you can stop anytime.
