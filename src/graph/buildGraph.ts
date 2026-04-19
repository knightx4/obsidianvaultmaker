import path from "path";
import matter from "gray-matter";
import { loadAtomsFile, type AtomEdgeRecord } from "../storage/atomsStore.js";
import { parseRelationshipLinksFromContent } from "../agent/prompts.js";
import { listMarkdownFiles, readNote } from "../agent/link.js";
import { writeFile, mkdir } from "fs/promises";

const VAULTMAKER_DIR = ".vaultmaker";
const GRAPH_FILE = "graph.json";

export interface GraphNode {
  id: string;
  kind: "atom" | "note" | "moc";
  title: string;
  path?: string;
  sourceId?: string;
  atomId?: string;
}

export interface GraphEdge {
  id: string;
  fromId: string;
  toId: string;
  relation: string;
  provenance: "inline" | "inferred";
}

export interface GraphFile {
  schemaVersion: number;
  updatedAt: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

const MOC_PREFIX = "MOCs/";

function titleToNodeId(title: string): string {
  return `title:${title}`;
}

function atomIdToNodeId(atomId: string): string {
  return `atom:${atomId}`;
}

function edgeKey(fromId: string, toId: string, relation: string, provenance: GraphEdge["provenance"]): string {
  return `${fromId}|${relation}|${toId}|${provenance}`;
}

/**
 * Build machine-readable graph from atoms.json + Relationship:: lines in markdown notes.
 */
export async function buildGraph(vaultPath: string): Promise<GraphFile> {
  const atomsData = await loadAtomsFile(vaultPath);
  const nodeMap = new Map<string, GraphNode>();
  const edgeMap = new Map<string, GraphEdge>();

  const titleToAtomId = new Map<string, string>();
  for (const a of atomsData.atoms) {
    titleToAtomId.set(a.title, a.atomId);
    const nid = atomIdToNodeId(a.atomId);
    nodeMap.set(nid, {
      id: nid,
      kind: "atom",
      title: a.title,
      path: a.path,
      sourceId: a.sourceId,
      atomId: a.atomId,
    });
  }

  for (const e of atomsData.edges) {
    const fromN = atomIdToNodeId(e.fromAtomId);
    const toN = atomIdToNodeId(e.toAtomId);
    if (!nodeMap.has(fromN)) {
      nodeMap.set(fromN, {
        id: fromN,
        kind: "atom",
        title: e.fromAtomId,
        atomId: e.fromAtomId,
      });
    }
    if (!nodeMap.has(toN)) {
      nodeMap.set(toN, {
        id: toN,
        kind: "atom",
        title: e.toAtomId,
        atomId: e.toAtomId,
      });
    }
    const ge: GraphEdge = {
      id: e.id,
      fromId: fromN,
      toId: toN,
      relation: e.relation,
      provenance: e.provenance,
    };
    edgeMap.set(ge.id, ge);
  }

  const files = await listMarkdownFiles(vaultPath);
  for (const rel of files) {
    const baseTitle = path.basename(rel, ".md");
    const isMoc = rel.startsWith(MOC_PREFIX) || rel.startsWith("MOCs\\");
    const fromTitle = baseTitle;
    const fromId = titleToAtomId.has(fromTitle)
      ? atomIdToNodeId(titleToAtomId.get(fromTitle)!)
      : titleToNodeId(fromTitle);

    if (!nodeMap.has(fromId)) {
      nodeMap.set(fromId, {
        id: fromId,
        kind: isMoc ? "moc" : "note",
        title: fromTitle,
        path: rel,
      });
    }

    let body = "";
    try {
      const raw = await readNote(vaultPath, rel);
      const parsed = matter(raw);
      body = (parsed.content ?? "").trim();
    } catch {
      continue;
    }

    const links = parseRelationshipLinksFromContent(body);
    for (const { relationship, title: toTitle } of links) {
      const toId = titleToAtomId.has(toTitle)
        ? atomIdToNodeId(titleToAtomId.get(toTitle)!)
        : titleToNodeId(toTitle);
      if (!nodeMap.has(toId)) {
        nodeMap.set(toId, {
          id: toId,
          kind: "note",
          title: toTitle,
        });
      }
      const ek = edgeKey(fromId, toId, relationship, "inline");
      const eid = `e-${Buffer.from(ek).toString("base64url").slice(0, 48)}`;
      if (!edgeMap.has(eid)) {
        edgeMap.set(eid, {
          id: eid,
          fromId,
          toId,
          relation: relationship,
          provenance: "inline",
        });
      }
    }
  }

  const graph: GraphFile = {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    nodes: [...nodeMap.values()],
    edges: [...edgeMap.values()],
  };

  const outPath = path.join(vaultPath, VAULTMAKER_DIR, GRAPH_FILE);
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(graph, null, 2), "utf-8");
  return graph;
}

export function atomEdgeRecordFromTitles(
  fromAtomId: string,
  toAtomId: string,
  relation: string,
  provenance: AtomEdgeRecord["provenance"]
): AtomEdgeRecord {
  const id = `ae-${[fromAtomId, toAtomId, relation, provenance].join("-").replace(/[^a-zA-Z0-9-]+/g, "_").slice(0, 120)}`;
  return { id, fromAtomId, toAtomId, relation, provenance };
}
