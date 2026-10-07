import Anthropic from "@anthropic-ai/sdk";
import { GatewayError } from "@/lib/errors";
import type { ProviderAdapter, ProviderRequest, ProviderResponse } from "./types";

export class AnthropicAdapter implements ProviderAdapter {
  readonly name = "anthropic" as const;
  private client: Anthropic | null = null;

  isConfigured(): boolean {
    return Boolean(process.env.ANTHROPIC_API_KEY);
  }

  async chat(request: ProviderRequest): Promise<ProviderResponse> {
    const client = (this.client ??= new Anthropic());

    // Anthropic takes the system prompt as a top-level field, not a message.
    const system = request.messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n\n");
    const messages: Anthropic.MessageParam[] = [];
    for (const m of request.messages) {
      if (m.role !== "system") messages.push({ role: m.role, content: m.content });
    }

    try {
      const res = await client.messages.create({
        model: request.model,
        max_tokens: request.maxOutputTokens,
        ...(system ? { system } : {}),
        messages,
      });
      let text = "";
      for (const block of res.content) {
        if (block.type === "text") text += block.text;
      }
      return {
        text,
        inputTokens: res.usage.input_tokens,
        outputTokens: res.usage.output_tokens,
        stopReason: res.stop_reason,
      };
    } catch (err) {
      if (err instanceof Anthropic.RateLimitError) {
        throw new GatewayError(429, "provider_rate_limited", "Anthropic rate limit reached");
      }
      if (err instanceof Anthropic.AuthenticationError) {
        throw new GatewayError(502, "provider_auth_failed", "Anthropic rejected the configured API key");
      }
      if (err instanceof Anthropic.APIConnectionError) {
        throw new GatewayError(502, "provider_unreachable", "Could not reach Anthropic");
      }
      if (err instanceof Anthropic.APIError) {
        throw new GatewayError(502, "provider_error", `Anthropic returned ${err.status}: ${err.message}`);
      }
      throw err;
    }
  }
}
