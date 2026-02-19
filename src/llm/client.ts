/**
 * Generic LLM completion interface so we can swap providers later.
 */
export interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LLMClient {
  complete(messages: LLMMessage[], options?: { maxTokens?: number }): Promise<string>;
}
