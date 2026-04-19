import Anthropic from "@anthropic-ai/sdk";
import type { ContentBlock, MessageParam } from "@anthropic-ai/sdk/resources/messages";
import type { LLMClient, LLMMessage } from "./client.js";

const DEFAULT_MODEL = "claude-sonnet-4-20250514";

function splitSystemAndMessages(messages: LLMMessage[]): { system: string | undefined; conversation: MessageParam[] } {
  const systemParts: string[] = [];
  const conversation: MessageParam[] = [];
  for (const m of messages) {
    if (m.role === "system") {
      systemParts.push(m.content);
      continue;
    }
    conversation.push({
      role: m.role === "assistant" ? "assistant" : "user",
      content: m.content,
    });
  }
  const system = systemParts.length > 0 ? systemParts.join("\n\n") : undefined;
  return { system, conversation };
}

function textFromMessageContent(content: ContentBlock[]): string {
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === "text" && "text" in block && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("");
}

/**
 * Claude Messages API. Maps OpenAI-style {system,user,assistant}* to Anthropic (system + alternating user/assistant).
 */
export function createAnthropicClient(apiKey: string, model?: string): LLMClient {
  const client = new Anthropic({ apiKey });
  const resolvedModel = model?.trim() || process.env.ANTHROPIC_MODEL?.trim() || DEFAULT_MODEL;

  return {
    async complete(messages: LLMMessage[], options?: { maxTokens?: number }): Promise<string> {
      const { system, conversation } = splitSystemAndMessages(messages);
      const maxTokens = options?.maxTokens ?? 4096;
      const response = await client.messages.create({
        model: resolvedModel,
        max_tokens: maxTokens,
        ...(system ? { system } : {}),
        messages: conversation,
      });
      return textFromMessageContent(response.content);
    },
  };
}
