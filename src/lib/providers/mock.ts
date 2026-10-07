import type { ProviderAdapter, ProviderRequest, ProviderResponse } from "./types";

/** Rough token estimate (about 4 characters per token) used when no provider reports usage. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/**
 * Deterministic stand-in used when a provider has no API key, so the whole
 * gateway can be run and demoed with zero setup. Never calls the network.
 */
export class MockAdapter implements ProviderAdapter {
  readonly name = "mock" as const;

  constructor(private readonly simulateLatency = true) {}

  isConfigured(): boolean {
    return true;
  }

  async chat(request: ProviderRequest): Promise<ProviderResponse> {
    const lastUser = [...request.messages].reverse().find((m) => m.role === "user");
    const prompt = lastUser?.content ?? "";
    const preview = prompt.length > 80 ? `${prompt.slice(0, 80)}...` : prompt;
    const text = `[mock:${request.model}] Received your request ("${preview}"). This is a simulated response because no provider API key is configured.`;

    if (this.simulateLatency) {
      // Stable per prompt, so repeated demo calls feel like a real model without randomness.
      const delay = 120 + ((prompt.length * 37) % 380);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    return {
      text,
      inputTokens: request.messages.reduce((sum, m) => sum + estimateTokens(m.content), 0),
      outputTokens: estimateTokens(text),
      stopReason: "end_turn",
    };
  }
}
