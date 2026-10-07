import { canonicalJson, sha256Hex } from "@/lib/audit/canonical";
import { appendRecord, countRecentRequests, type NewEntry } from "@/lib/audit/chain";
import type { Db } from "@/lib/db/client";
import { getEnv } from "@/lib/env";
import { GatewayError } from "@/lib/errors";
import { evaluatePolicy, type Decision } from "@/lib/policy/engine";
import { loadPolicy } from "@/lib/policy/loader";
import { estimateCostMicros } from "@/lib/pricing";
import { resolveProvider, type ProviderAdapter, type ResolvedProvider } from "@/lib/providers";
import type { ChatRequest } from "@/lib/validation";

export interface GatewayDeps {
  db: Db;
  /** Clock, replaceable so tests and the seed script can control time. */
  now?: () => Date;
  policyDir?: string;
  checkpointInterval?: number;
  /** Answer with this adapter instead of the one the model resolves to. */
  adapter?: ProviderAdapter;
  /** Record this provider latency instead of the measured one (seed script only). */
  latencyMs?: number;
}

export interface ChatOutcome {
  status: number;
  body: {
    record_id: string;
    record_hash: string;
    decision: Decision;
    rules_fired: string[];
    model: string;
    provider: string;
    mock: boolean;
    response: { role: "assistant"; content: string } | null;
    usage: { input_tokens: number; output_tokens: number; cost_usd: number };
    latency_ms: number;
    message?: string;
  };
}

function tryResolve(model: string): ResolvedProvider | null {
  try {
    return resolveProvider(model);
  } catch (err) {
    if (err instanceof GatewayError && err.code === "unknown_model") return null;
    throw err;
  }
}

/**
 * The whole request lifecycle: policy check, redaction, provider call and
 * audit record. Every path that gets past "which app is this?" writes exactly
 * one audit record, including blocked requests and provider failures.
 */
export async function processChat(input: ChatRequest, deps: GatewayDeps): Promise<ChatOutcome> {
  const started = performance.now();
  const now = (deps.now ?? (() => new Date()))();
  const interval = deps.checkpointInterval ?? getEnv().LEDGERLINE_CHECKPOINT_INTERVAL;
  const elapsed = () => deps.latencyMs ?? Math.round(performance.now() - started);

  // An unknown app has no policy to judge the request by, so it is rejected
  // before the audit log. Everything after this point is recorded.
  const { policy } = loadPolicy(input.app_id, deps.policyDir);

  const resolved = tryResolve(input.model);
  if (!resolved && policy.allowed_models.includes(input.model)) {
    throw new GatewayError(
      500,
      "policy_invalid",
      `Policy for "${policy.app_id}" allows model "${input.model}", but no provider is registered for it`,
    );
  }
  const adapter = deps.adapter ?? resolved?.adapter;
  const provider = resolved?.provider ?? "unknown";
  const mock = adapter?.name === "mock";

  const windowStart = new Date(now.getTime() - policy.rate_limit.window_seconds * 1000).toISOString();
  const verdict = evaluatePolicy(policy, {
    model: input.model,
    messages: input.messages,
    recentRequestCount: countRecentRequests(deps.db, policy.app_id, input.user_id, windowStart),
  });

  const base = {
    ts: now.toISOString(),
    appId: policy.app_id,
    userId: input.user_id,
    provider,
    mock,
    model: input.model,
    decision: verdict.decision,
    rulesFired: verdict.rulesFired,
    // Only the hash of the original prompt is kept. The text that is stored
    // and sent onwards is the redacted version.
    promptHash: sha256Hex(canonicalJson(input.messages)),
    promptRedacted: canonicalJson(verdict.messages),
  } satisfies Partial<NewEntry>;

  if (verdict.decision === "BLOCK" || !adapter) {
    // Always the real measurement: a blocked request never waits on a provider.
    const latencyMs = Math.round(performance.now() - started);
    const record = appendRecord(
      deps.db,
      { ...base, responseText: null, inputTokens: 0, outputTokens: 0, costMicros: 0, latencyMs, status: "blocked", errorCode: null },
      interval,
    );
    return {
      status: verdict.rulesFired.includes("rate_limit") ? 429 : 403,
      body: {
        record_id: record.id,
        record_hash: record.recordHash,
        decision: "BLOCK",
        rules_fired: verdict.rulesFired,
        model: input.model,
        provider,
        mock,
        response: null,
        usage: { input_tokens: 0, output_tokens: 0, cost_usd: 0 },
        latency_ms: latencyMs,
        message: "Request blocked by policy. Nothing was sent to the model provider.",
      },
    };
  }

  let reply;
  try {
    // Only the redacted messages ever leave the gateway.
    reply = await adapter.chat({
      model: input.model,
      messages: verdict.messages,
      maxOutputTokens: policy.max_output_tokens,
    });
  } catch (err) {
    // A failed provider call is still an event the log must show.
    const failure =
      err instanceof GatewayError
        ? err
        : new GatewayError(502, "provider_error", `Provider call failed: ${(err as Error).message}`);
    const record = appendRecord(
      deps.db,
      { ...base, responseText: null, inputTokens: 0, outputTokens: 0, costMicros: 0, latencyMs: elapsed(), status: "provider_error", errorCode: failure.code },
      interval,
    );
    throw new GatewayError(failure.status, failure.code, failure.message, { record_id: record.id });
  }

  const latencyMs = elapsed();
  const costMicros = estimateCostMicros(input.model, reply.inputTokens, reply.outputTokens);
  const record = appendRecord(
    deps.db,
    {
      ...base,
      responseText: reply.text,
      inputTokens: reply.inputTokens,
      outputTokens: reply.outputTokens,
      costMicros,
      latencyMs,
      status: "ok",
      errorCode: null,
    },
    interval,
  );

  return {
    status: 200,
    body: {
      record_id: record.id,
      record_hash: record.recordHash,
      decision: verdict.decision,
      rules_fired: verdict.rulesFired,
      model: input.model,
      provider,
      mock,
      response: { role: "assistant", content: reply.text },
      usage: { input_tokens: reply.inputTokens, output_tokens: reply.outputTokens, cost_usd: costMicros / 1_000_000 },
      latency_ms: latencyMs,
    },
  };
}
