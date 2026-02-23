import OpenAI from "openai";
import type { LLMClient, LLMMessage } from "./client.js";
import type { EmbeddingClient } from "./embedding.js";

export function createOpenAIClient(apiKey: string): LLMClient {
  const openai = new OpenAI({ apiKey });

  return {
    async complete(messages: LLMMessage[], options?: { maxTokens?: number }): Promise<string> {
      const response = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        max_tokens: options?.maxTokens ?? 4096,
      });
      const content = response.choices[0]?.message?.content;
      if (content == null) throw new Error("Empty LLM response");
      return content;
    },
  };
}

const EMBEDDING_MODEL = "text-embedding-3-small";

export function createOpenAIEmbeddingClient(apiKey: string): EmbeddingClient {
  const openai = new OpenAI({ apiKey });

  return {
    async embed(text: string): Promise<number[]> {
      const response = await openai.embeddings.create({
        model: EMBEDDING_MODEL,
        input: text.slice(0, 8000),
      });
      const vec = response.data[0]?.embedding;
      if (!vec || !Array.isArray(vec)) throw new Error("Empty embedding response");
      return vec;
    },
  };
}
