/**
 * Fixture-based checks for agent-oriented extraction quality.
 * Run: npx tsx src/eval/run.ts /absolute/path/to/vault
 */
import { readFile } from "fs/promises";
import path from "path";
import { loadAtomsFile } from "../storage/atomsStore.js";

async function main(): Promise<void> {
  const vaultPath = process.argv[2];
  if (!vaultPath) {
    console.error("Usage: npx tsx src/eval/run.ts <vaultPath>");
    process.exit(1);
  }

  const atoms = await loadAtomsFile(vaultPath);
  const extracted = atoms.atoms.filter((a) => a.provenance === "extracted");
  const withEvidence = extracted.filter((a) => a.evidenceRefs && a.evidenceRefs.length > 0);
  const citationCoverage =
    extracted.length === 0 ? 1 : withEvidence.length / extracted.length;

  const report = {
    vaultPath,
    atomCount: atoms.atoms.length,
    extractedCount: extracted.length,
    extractedWithEvidenceRefs: withEvidence.length,
    citationCoverage,
  };

  console.log(JSON.stringify(report, null, 2));

  const graphPath = path.join(vaultPath, ".vaultmaker", "graph.json");
  try {
    const raw = await readFile(graphPath, "utf-8");
    const g = JSON.parse(raw) as { nodes?: unknown[]; edges?: unknown[] };
    console.log(
      JSON.stringify(
        {
          graphNodes: Array.isArray(g.nodes) ? g.nodes.length : 0,
          graphEdges: Array.isArray(g.edges) ? g.edges.length : 0,
        },
        null,
        2
      )
    );
  } catch {
    console.log(JSON.stringify({ graphNodes: 0, graphEdges: 0, note: "no graph.json" }, null, 2));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
