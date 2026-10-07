export type ProviderName = "anthropic" | "openai" | "mock";

/** Provider-neutral message shape. Each adapter maps this to its own SDK types. */
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ProviderRequest {
  model: string;
  messages: ChatMessage[];
  maxOutputTokens: number;
}

export interface ProviderResponse {
  text: string;
  inputTokens: number;
  outputTokens: number;
  stopReason: string | null;
}

/**
 * To add a provider: implement this interface, then register it in
 * providers/index.ts with the model-name prefix it serves.
 */
export interface ProviderAdapter {
  readonly name: ProviderName;
  /** False when the provider's API key is missing; the gateway then uses the mock. */
  isConfigured(): boolean;
  chat(request: ProviderRequest): Promise<ProviderResponse>;
}
