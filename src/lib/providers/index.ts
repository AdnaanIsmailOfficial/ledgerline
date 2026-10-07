import { GatewayError } from "@/lib/errors";
import { AnthropicAdapter } from "./anthropic";
import { MockAdapter } from "./mock";
import { OpenAIAdapter } from "./openai";
import type { ProviderAdapter, ProviderName } from "./types";

export * from "./types";
export { MockAdapter, estimateTokens } from "./mock";

type RealProvider = Exclude<ProviderName, "mock">;

interface Registration {
  provider: RealProvider;
  /** Model names matching this pattern are routed to the adapter. */
  match: RegExp;
  adapter: ProviderAdapter;
}

// Register a new provider by adding one line here.
const registry: Registration[] = [
  { provider: "anthropic", match: /^claude-/, adapter: new AnthropicAdapter() },
  { provider: "openai", match: /^(gpt-|o\d|chatgpt-)/, adapter: new OpenAIAdapter() },
];

const mock = new MockAdapter();

export interface ResolvedProvider {
  /** The provider the model belongs to. */
  provider: RealProvider;
  /** The adapter that will actually answer: the real one, or the mock if no key is set. */
  adapter: ProviderAdapter;
  mock: boolean;
}

export function resolveProvider(model: string): ResolvedProvider {
  const entry = registry.find((r) => r.match.test(model));
  if (!entry) {
    throw new GatewayError(400, "unknown_model", `No provider is registered for model "${model}"`);
  }
  if (!entry.adapter.isConfigured()) {
    return { provider: entry.provider, adapter: mock, mock: true };
  }
  return { provider: entry.provider, adapter: entry.adapter, mock: false };
}
