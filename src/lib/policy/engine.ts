import { estimateTokens } from "@/lib/providers/mock";
import type { ChatMessage } from "@/lib/providers/types";
import { PII_TYPES, redactPii } from "./pii";
import type { Policy } from "./schema";

export type Decision = "ALLOW" | "REDACT" | "BLOCK";

export interface PolicyInput {
  model: string;
  messages: ChatMessage[];
  /** Requests this user made to this app inside the policy's rate-limit window. */
  recentRequestCount: number;
}

export interface PolicyResult {
  decision: Decision;
  /**
   * Rule ids in a stable order: model_not_allowed, max_input_tokens, rate_limit,
   * blocked_topic:<id>, pii:<type>.
   */
  rulesFired: string[];
  /** The messages with PII replaced. This is the only version that may leave the gateway. */
  messages: ChatMessage[];
  estimatedInputTokens: number;
}

function escapeRegex(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function topicMatches(topic: Policy["blocked_topics"][number], text: string): boolean {
  for (const keyword of topic.keywords) {
    // Lookarounds instead of \b so keywords that start or end with punctuation still work.
    const re = new RegExp(`(?<![A-Za-z0-9])${escapeRegex(keyword)}(?![A-Za-z0-9])`, "i");
    if (re.test(text)) return true;
  }
  return topic.patterns.some((source) => new RegExp(source, "i").test(text));
}

/**
 * Pure function: same policy and input always give the same decision.
 * Every rule is evaluated (no early exit) so the audit log shows all the
 * reasons a request was stopped, not just the first one.
 */
export function evaluatePolicy(policy: Policy, input: PolicyInput): PolicyResult {
  const blocking: string[] = [];

  if (!policy.allowed_models.includes(input.model)) blocking.push("model_not_allowed");

  const estimatedInputTokens = input.messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
  if (estimatedInputTokens > policy.max_input_tokens) blocking.push("max_input_tokens");

  if (input.recentRequestCount >= policy.rate_limit.requests) blocking.push("rate_limit");

  // Topics are checked against the original text, before redaction changes it.
  const fullText = input.messages.map((m) => m.content).join("\n");
  for (const topic of policy.blocked_topics) {
    if (topicMatches(topic, fullText)) blocking.push(`blocked_topic:${topic.id}`);
  }

  // Redaction always runs, including on blocked requests, because the redacted
  // text is what gets stored in the audit payload.
  const found = new Set<string>();
  const messages = input.messages.map((m) => {
    const result = redactPii(m.content, policy.pii_redaction);
    for (const type of Object.keys(result.counts)) found.add(type);
    return { role: m.role, content: result.text };
  });
  const pii = PII_TYPES.filter((t) => found.has(t)).map((t) => `pii:${t}`);

  const decision: Decision = blocking.length > 0 ? "BLOCK" : pii.length > 0 ? "REDACT" : "ALLOW";
  return { decision, rulesFired: [...blocking, ...pii], messages, estimatedInputTokens };
}
