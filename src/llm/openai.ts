import OpenAI from "openai";
import type { LLMClient, LLMMessage } from "./client.js";

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
