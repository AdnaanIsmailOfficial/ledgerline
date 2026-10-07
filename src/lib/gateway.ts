import { evaluatePolicy, type Decision } from "@/lib/policy/engine";
import { loadPolicy } from "@/lib/policy/loader";
import { resolveProvider } from "@/lib/providers";
import type { ChatRequest } from "@/lib/validation";

export interface ChatOutcome {
  status: number;
  body: {
    decision: Decision;
    rules_fired: string[];
    model: string;
    provider: string;
    mock: boolean;
    response: { role: "assistant"; content: string } | null;
    usage: { input_tokens: number; output_tokens: number };
    latency_ms: number;
    message?: string;
  };
}

export async function processChat(input: ChatRequest): Promise<ChatOutcome> {
  const started = performance.now();
  const { policy } = loadPolicy(input.app_id);
  const resolved = resolveProvider(input.model);

  const verdict = evaluatePolicy(policy, {
    model: input.model,
    messages: input.messages,
    recentRequestCount: 0, // real count arrives with the audit log
  });

  if (verdict.decision === "BLOCK") {
    return {
      status: verdict.rulesFired.includes("rate_limit") ? 429 : 403,
      body: {
        decision: "BLOCK",
        rules_fired: verdict.rulesFired,
        model: input.model,
        provider: resolved.provider,
        mock: resolved.mock,
        response: null,
        usage: { input_tokens: 0, output_tokens: 0 },
        latency_ms: Math.round(performance.now() - started),
        message: "Request blocked by policy. Nothing was sent to the model provider.",
      },
    };
  }

  // Only the redacted messages ever leave the gateway.
  const reply = await resolved.adapter.chat({
    model: input.model,
    messages: verdict.messages,
    maxOutputTokens: policy.max_output_tokens,
  });

  return {
    status: 200,
    body: {
      decision: verdict.decision,
      rules_fired: verdict.rulesFired,
      model: input.model,
      provider: resolved.provider,
      mock: resolved.mock,
      response: { role: "assistant", content: reply.text },
      usage: { input_tokens: reply.inputTokens, output_tokens: reply.outputTokens },
      latency_ms: Math.round(performance.now() - started),
    },
  };
}
