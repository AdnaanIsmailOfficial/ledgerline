/**
 * List prices in US dollars per million tokens, used only for the dashboard's
 * cost estimate. Prices change; treat the output as an estimate, not a bill.
 */
const PRICES: Record<string, { input: number; output: number }> = {
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-haiku-4-5": { input: 1, output: 5 },
  "gpt-4o": { input: 2.5, output: 10 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
};

/**
 * Estimated cost in millionths of a dollar. Dollars-per-million-tokens times
 * tokens is already in millionths of a dollar, so no further scaling is needed.
 * Returns 0 for a model with no known price.
 */
export function estimateCostMicros(model: string, inputTokens: number, outputTokens: number): number {
  const price = PRICES[model];
  if (!price) return 0;
  return Math.round(inputTokens * price.input + outputTokens * price.output);
}
