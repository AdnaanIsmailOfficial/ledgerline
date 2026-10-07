import { resolveProvider } from "@/lib/providers";
import type { ChatRequest } from "@/lib/validation";

export interface ChatResult {
  model: string;
  provider: string;
  mock: boolean;
  response: { role: "assistant"; content: string };
  usage: { input_tokens: number; output_tokens: number };
  latency_ms: number;
}

export async function processChat(input: ChatRequest): Promise<ChatResult> {
  const resolved = resolveProvider(input.model);
  const started = performance.now();
  const reply = await resolved.adapter.chat({
    model: input.model,
    messages: input.messages,
    maxOutputTokens: 1024,
  });
  return {
    model: input.model,
    provider: resolved.provider,
    mock: resolved.mock,
    response: { role: "assistant", content: reply.text },
    usage: { input_tokens: reply.inputTokens, output_tokens: reply.outputTokens },
    latency_ms: Math.round(performance.now() - started),
  };
}
