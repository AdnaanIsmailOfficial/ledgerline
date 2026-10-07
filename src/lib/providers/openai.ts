import OpenAI from "openai";
import { GatewayError } from "@/lib/errors";
import type { ProviderAdapter, ProviderRequest, ProviderResponse } from "./types";

export class OpenAIAdapter implements ProviderAdapter {
  readonly name = "openai" as const;
  private client: OpenAI | null = null;

  isConfigured(): boolean {
    return Boolean(process.env.OPENAI_API_KEY);
  }

  async chat(request: ProviderRequest): Promise<ProviderResponse> {
    const client = (this.client ??= new OpenAI());
    try {
      const res = await client.chat.completions.create({
        model: request.model,
        max_completion_tokens: request.maxOutputTokens,
        messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
      });
      const choice = res.choices[0];
      return {
        text: choice?.message.content ?? "",
        inputTokens: res.usage?.prompt_tokens ?? 0,
        outputTokens: res.usage?.completion_tokens ?? 0,
        stopReason: choice?.finish_reason ?? null,
      };
    } catch (err) {
      if (err instanceof OpenAI.RateLimitError) {
        throw new GatewayError(429, "provider_rate_limited", "OpenAI rate limit reached");
      }
      if (err instanceof OpenAI.AuthenticationError) {
        throw new GatewayError(502, "provider_auth_failed", "OpenAI rejected the configured API key");
      }
      if (err instanceof OpenAI.APIConnectionError) {
        throw new GatewayError(502, "provider_unreachable", "Could not reach OpenAI");
      }
      if (err instanceof OpenAI.APIError) {
        throw new GatewayError(502, "provider_error", `OpenAI returned ${err.status}: ${err.message}`);
      }
      throw err;
    }
  }
}
