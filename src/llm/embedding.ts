/**
 * Optional embedding client for retrieval. When not available, retrieval uses keyword fallback.
 */
export interface EmbeddingClient {
  embed(text: string): Promise<number[]>;
}
