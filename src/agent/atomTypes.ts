export type AtomKind = "claim" | "evidence" | "observation" | "method" | "theme" | "conclusion" | "other";

export interface EvidenceRef {
  chunkId: string;
  start: number;
  end: number;
  quote?: string;
}

/** LLM output for one extracted insight (before server assigns atomId). */
export interface ExtractedAtomPayload {
  title: string;
  content: string;
  type?: string;
  confidence?: number;
  importance?: string;
  tags?: string[];
  evidenceRefs?: EvidenceRef[];
}
