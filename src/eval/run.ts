/**
 * Fixture-based checks for agent-oriented extraction quality.
 * Run: npx tsx src/eval/run.ts /absolute/path/to/vault [expectations.json]
 * Default expectations: eval/fixtures/sample-expectations.json (repo root)
 */
import { readFile } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { loadAtomsFile } from "../storage/atomsStore.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface Expectations {
  minExtractedAtoms?: number;
  minCitationCoverage?: number;
  minGraphNodes?: number;
  minGraphEdges?: number;
}

async function loadExpectations(explicitPath?: string): Promise<Expectations> {
  const defaultPath = path.resolve(__dirname, "../../eval/fixtures/sample-expectations.json");
  const p = explicitPath ?? defaultPath;
  try {
    const raw = await readFile(p, "utf-8");
    return JSON.parse(raw) as Expectations;
  } catch {
    return {};
  }
}

async function main(): Promise<void> {
  const vaultPath = process.argv[2];
  const expectationsPath = process.argv[3];
  if (!vaultPath) {
    console.error("Usage: npx tsx src/eval/run.ts <vaultPath> [expectations.json]");
    process.exit(1);
  }

  const exp = await loadExpectations(expectationsPath);

  const atoms = await loadAtomsFile(vaultPath);
  const extracted = atoms.atoms.filter((a) => a.provenance === "extracted");
  const withEvidence = extracted.filter((a) => a.evidenceRefs && a.evidenceRefs.length > 0);
  const citationCoverage =
    extracted.length === 0 ? 1 : withEvidence.length / extracted.length;

  let graphNodes = 0;
  let graphEdges = 0;
  const graphPath = path.join(vaultPath, ".vaultmaker", "graph.json");
  try {
    const raw = await readFile(graphPath, "utf-8");
    const g = JSON.parse(raw) as { nodes?: unknown[]; edges?: unknown[] };
    graphNodes = Array.isArray(g.nodes) ? g.nodes.length : 0;
    graphEdges = Array.isArray(g.edges) ? g.edges.length : 0;
  } catch {
    // no graph
  }

  const report = {
    vaultPath,
    atomCount: atoms.atoms.length,
    extractedCount: extracted.length,
    extractedWithEvidenceRefs: withEvidence.length,
    citationCoverage,
    graphNodes,
    graphEdges,
  };

  console.log(JSON.stringify(report, null, 2));

  const failures: string[] = [];
  if (typeof exp.minExtractedAtoms === "number" && extracted.length < exp.minExtractedAtoms) {
    failures.push(`extractedCount ${extracted.length} < minExtractedAtoms ${exp.minExtractedAtoms}`);
  }
  if (typeof exp.minCitationCoverage === "number" && citationCoverage < exp.minCitationCoverage) {
    failures.push(`citationCoverage ${citationCoverage} < minCitationCoverage ${exp.minCitationCoverage}`);
  }
  if (typeof exp.minGraphNodes === "number" && graphNodes < exp.minGraphNodes) {
    failures.push(`graphNodes ${graphNodes} < minGraphNodes ${exp.minGraphNodes}`);
  }
  if (typeof exp.minGraphEdges === "number" && graphEdges < exp.minGraphEdges) {
    failures.push(`graphEdges ${graphEdges} < minGraphEdges ${exp.minGraphEdges}`);
  }

  if (failures.length > 0) {
    console.error("EVAL FAILED:", failures.join("; "));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
