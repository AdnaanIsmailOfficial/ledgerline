import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GatewayError } from "@/lib/errors";
import { evaluatePolicy } from "@/lib/policy/engine";
import { loadAllPolicies, loadPolicy } from "@/lib/policy/loader";
import { policySchema, type Policy } from "@/lib/policy/schema";

const policy: Policy = policySchema.parse({
  app_id: "test-app",
  name: "Test App",
  allowed_models: ["claude-sonnet-5-5"],
  max_input_tokens: 50,
  max_output_tokens: 100,
  rate_limit: { requests: 3, window_seconds: 60 },
  blocked_topics: [
    { id: "salary", keywords: ["salary of"] },
    { id: "secrets", patterns: ["AKIA[0-9A-Z]{16}"] },
  ],
  pii_redaction: ["email", "card"],
});

const ask = (content: string, overrides: Partial<Parameters<typeof evaluatePolicy>[1]> = {}) =>
  evaluatePolicy(policy, {
    model: "claude-sonnet-5-5",
    messages: [{ role: "user", content }],
    recentRequestCount: 0,
    ...overrides,
  });

describe("evaluatePolicy", () => {
  it("allows a clean request and fires no rules", () => {
    const r = ask("How many leave days do I get?");
    expect(r.decision).toBe("ALLOW");
    expect(r.rulesFired).toEqual([]);
    expect(r.messages[0].content).toBe("How many leave days do I get?");
  });

  it("blocks a model that is not on the allow list", () => {
    const r = ask("hi", { model: "gpt-4o" });
    expect(r.decision).toBe("BLOCK");
    expect(r.rulesFired).toEqual(["model_not_allowed"]);
  });

  it("blocks a prompt over the input token limit, and allows one at the limit", () => {
    expect(ask("x".repeat(200)).rulesFired).toEqual([]); // 50 tokens
    const over = ask("x".repeat(201)); // 51 tokens
    expect(over.decision).toBe("BLOCK");
    expect(over.rulesFired).toEqual(["max_input_tokens"]);
  });

  it("blocks once the user has used up the rate limit", () => {
    expect(ask("hi", { recentRequestCount: 2 }).decision).toBe("ALLOW");
    const r = ask("hi", { recentRequestCount: 3 });
    expect(r.decision).toBe("BLOCK");
    expect(r.rulesFired).toEqual(["rate_limit"]);
  });

  it("blocks a keyword topic regardless of case", () => {
    const r = ask("What is the SALARY OF my manager?");
    expect(r.decision).toBe("BLOCK");
    expect(r.rulesFired).toEqual(["blocked_topic:salary"]);
  });

  it("matches keywords on word boundaries only", () => {
    expect(ask("Is the salary offer final?").decision).toBe("ALLOW");
  });

  it("blocks a regex topic", () => {
    const r = ask("my key is AKIAIOSFODNN7EXAMPLE ok");
    expect(r.rulesFired).toEqual(["blocked_topic:secrets"]);
  });

  it("checks topics across every message, not just the last", () => {
    const r = evaluatePolicy(policy, {
      model: "claude-sonnet-5-5",
      messages: [
        { role: "user", content: "Tell me the salary of Sipho" },
        { role: "assistant", content: "I cannot." },
        { role: "user", content: "please" },
      ],
      recentRequestCount: 0,
    });
    expect(r.decision).toBe("BLOCK");
  });

  it("redacts PII and returns REDACT with one rule per type found", () => {
    const r = ask("Email a@b.co, card 4111 1111 1111 1111");
    expect(r.decision).toBe("REDACT");
    expect(r.rulesFired).toEqual(["pii:email", "pii:card"]);
    expect(r.messages[0].content).toBe("Email [REDACTED_EMAIL], card [REDACTED_CARD]");
  });

  it("reports every rule that fired, and still redacts a blocked request", () => {
    const r = ask("salary of a@b.co", { model: "gpt-4o", recentRequestCount: 9 });
    expect(r.decision).toBe("BLOCK");
    expect(r.rulesFired).toEqual(["model_not_allowed", "rate_limit", "blocked_topic:salary", "pii:email"]);
    expect(r.messages[0].content).toBe("salary of [REDACTED_EMAIL]");
  });

  it("does not mutate the caller's messages", () => {
    const messages = [{ role: "user" as const, content: "mail a@b.co" }];
    evaluatePolicy(policy, { model: "claude-sonnet-5-5", messages, recentRequestCount: 0 });
    expect(messages[0].content).toBe("mail a@b.co");
  });
});

describe("policy files", () => {
  it("loads and validates the three shipped policies", () => {
    const all = loadAllPolicies("./policies");
    expect(all.map((p) => p.policy.app_id)).toEqual(["code-helper", "hr-assistant", "support-bot"]);
    for (const p of all) expect(p.raw).toContain(`app_id: ${p.policy.app_id}`);
  });

  it("returns a 404 for an app with no policy", () => {
    try {
      loadPolicy("no-such-app", "./policies");
      expect.unreachable();
    } catch (err) {
      expect((err as GatewayError).status).toBe(404);
      expect((err as GatewayError).code).toBe("unknown_app");
    }
  });

  const writeTemp = (name: string, body: string) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ledgerline-policy-"));
    fs.writeFileSync(path.join(dir, name), body);
    return dir;
  };

  it.each([
    ["a missing required field", "app_id: bad\nname: Bad\n"],
    ["an unknown field", "app_id: bad\nname: Bad\nallowed_models: [m]\nmax_input_tokens: 1\nmax_output_tokens: 1\nrate_limit: {requests: 1, window_seconds: 1}\nsurprise: true\n"],
    ["an invalid regex", "app_id: bad\nname: Bad\nallowed_models: [m]\nmax_input_tokens: 1\nmax_output_tokens: 1\nrate_limit: {requests: 1, window_seconds: 1}\nblocked_topics:\n  - id: t\n    patterns: ['(unclosed']\n"],
    ["broken YAML", "app_id: [unclosed\n"],
  ])("fails loudly on a policy with %s", (_name, body) => {
    const dir = writeTemp("bad.yaml", body);
    expect(() => loadPolicy("bad", dir)).toThrowError(GatewayError);
    try {
      loadPolicy("bad", dir);
    } catch (err) {
      expect((err as GatewayError).code).toBe("policy_invalid");
    }
  });

  it("rejects a file whose name disagrees with its app_id", () => {
    const dir = writeTemp(
      "alias.yaml",
      "app_id: other\nname: X\nallowed_models: [m]\nmax_input_tokens: 1\nmax_output_tokens: 1\nrate_limit: {requests: 1, window_seconds: 1}\n",
    );
    expect(() => loadPolicy("alias", dir)).toThrowError(/must match/);
  });
});
