import { asc } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex } from "@/lib/audit/canonical";
import { verifyChain } from "@/lib/audit/verify";
import type { Db } from "@/lib/db/client";
import { auditRecords, recordPayloads } from "@/lib/db/schema";
import { GatewayError } from "@/lib/errors";
import { processChat, type GatewayDeps } from "@/lib/gateway";
import type { ProviderAdapter, ProviderRequest } from "@/lib/providers";
import type { ChatRequest } from "@/lib/validation";
import { makeDb } from "./helpers";

/** Records exactly what the gateway sent to the "provider". */
class SpyAdapter implements ProviderAdapter {
  readonly name = "mock" as const;
  calls: ProviderRequest[] = [];
  fail: Error | null = null;
  isConfigured() {
    return true;
  }
  async chat(request: ProviderRequest) {
    this.calls.push(request);
    if (this.fail) throw this.fail;
    return { text: "ok", inputTokens: 10, outputTokens: 5, stopReason: "end_turn" };
  }
}

let db: Db;
let spy: SpyAdapter;
let clock: number;
let deps: GatewayDeps;

beforeEach(() => {
  db = makeDb();
  spy = new SpyAdapter();
  clock = Date.parse("2026-10-01T08:00:00.000Z");
  deps = { db, adapter: spy, policyDir: "./policies", checkpointInterval: 4, now: () => new Date(clock) };
});

const req = (content: string, overrides: Partial<ChatRequest> = {}): ChatRequest => ({
  app_id: "hr-assistant",
  user_id: "thandi",
  model: "claude-sonnet-5-5",
  messages: [{ role: "user", content }],
  ...overrides,
});

const rows = () => db.select().from(auditRecords).orderBy(asc(auditRecords.seq)).all();

describe("processChat", () => {
  it("logs an allowed request with hashes, tokens, cost and latency", async () => {
    const out = await processChat(req("How many leave days do I get?"), deps);
    expect(out.status).toBe(200);
    expect(out.body.decision).toBe("ALLOW");

    const [row] = rows();
    expect(row).toMatchObject({
      id: out.body.record_id,
      recordHash: out.body.record_hash,
      appId: "hr-assistant",
      userId: "thandi",
      model: "claude-sonnet-5-5",
      provider: "anthropic",
      decision: "ALLOW",
      rulesFired: "[]",
      inputTokens: 10,
      outputTokens: 5,
      costMicros: 70, // 10 * $2 + 5 * $10 per million tokens
      status: "ok",
      responseHash: sha256Hex("ok"),
    });
    expect(out.body.usage.cost_usd).toBe(0.00007);
  });

  it("sends only redacted text to the provider and never stores the original", async () => {
    const secret = "thandi.m@example.co.za";
    const id = "8001015009087";
    const original = `My email is ${secret} and my ID is ${id}. How much leave do I have?`;
    const out = await processChat(req(original), deps);

    expect(out.body.decision).toBe("REDACT");
    expect(out.body.rules_fired).toEqual(["pii:email", "pii:sa_id"]);

    const sent = spy.calls[0].messages[0].content;
    expect(sent).toBe("My email is [REDACTED_EMAIL] and my ID is [REDACTED_SA_ID]. How much leave do I have?");

    // Nothing anywhere in the database contains the raw values.
    const dump = JSON.stringify([rows(), db.select().from(recordPayloads).all()]);
    expect(dump).not.toContain(secret);
    expect(dump).not.toContain(id);

    // But the log can still prove what the original prompt was, to someone who has it.
    expect(rows()[0].promptHash).toBe(sha256Hex(canonicalJson([{ role: "user", content: original }])));
    expect(rows()[0].promptHash).not.toBe(rows()[0].redactedPromptHash);
  });

  it("logs a blocked request and never calls the provider", async () => {
    const out = await processChat(req("What is the salary of Sipho?"), deps);
    expect(out.status).toBe(403);
    expect(out.body).toMatchObject({ decision: "BLOCK", rules_fired: ["blocked_topic:salary-disclosure"], response: null });
    expect(spy.calls).toHaveLength(0);
    expect(rows()[0]).toMatchObject({ decision: "BLOCK", status: "blocked", responseHash: null, inputTokens: 0 });
  });

  it("blocks and logs a model that is not allowed, including one no provider serves", async () => {
    const a = await processChat(req("hi", { model: "gpt-4o" }), deps);
    const b = await processChat(req("hi", { model: "llama-3" }), deps);
    expect([a.status, b.status]).toEqual([403, 403]);
    expect(b.body.rules_fired).toEqual(["model_not_allowed"]);
    expect(rows().map((r) => r.provider)).toEqual(["openai", "unknown"]);
    expect(spy.calls).toHaveLength(0);
  });

  it("enforces the per-user rate limit from the log and frees up after the window", async () => {
    // hr-assistant allows 20 requests per 60 seconds.
    for (let i = 0; i < 20; i++) {
      clock += 1000;
      expect((await processChat(req("hi"), deps)).status).toBe(200);
    }
    clock += 1000;
    const limited = await processChat(req("hi"), deps);
    expect(limited.status).toBe(429);
    expect(limited.body.rules_fired).toEqual(["rate_limit"]);

    // Another user is unaffected.
    expect((await processChat(req("hi", { user_id: "sipho" }), deps)).status).toBe(200);

    clock += 61_000;
    expect((await processChat(req("hi"), deps)).status).toBe(200);
  });

  it("logs a provider failure and reports the record id with the error", async () => {
    spy.fail = new GatewayError(502, "provider_unreachable", "Could not reach Anthropic");
    await expect(processChat(req("hi"), deps)).rejects.toMatchObject({ status: 502, code: "provider_unreachable" });
    const [row] = rows();
    expect(row).toMatchObject({ status: "provider_error", errorCode: "provider_unreachable", responseHash: null });

    spy.fail = new Error("socket hang up");
    const err = await processChat(req("hi"), deps).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "provider_error", details: { record_id: rows()[1].id } });
  });

  it("rejects an unknown app without writing a record", async () => {
    await expect(processChat(req("hi", { app_id: "nope" }), deps)).rejects.toMatchObject({ status: 404, code: "unknown_app" });
    expect(rows()).toHaveLength(0);
  });

  it("leaves a log that verifies after a mix of outcomes", async () => {
    const prompts = ["hi", "mail me at a@b.co", "salary of Sipho", "leave policy?", "call 082 123 4567", "hello", "ok", "thanks", "bye"];
    for (const p of prompts) {
      clock += 1000;
      await processChat(req(p), deps);
    }
    expect(rows().map((r) => r.decision)).toEqual(["ALLOW", "REDACT", "BLOCK", "ALLOW", "REDACT", "ALLOW", "ALLOW", "ALLOW", "ALLOW"]);
    expect(verifyChain(db)).toMatchObject({ ok: true, records_checked: 9, checkpoints_checked: 2 });
  });

  it("keeps the chain intact when many requests finish at the same time", async () => {
    await Promise.all(Array.from({ length: 25 }, (_, i) => processChat(req(`q${i}`, { user_id: `u${i}` }), deps)));
    expect(rows().map((r) => r.seq)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
    expect(verifyChain(db).ok).toBe(true);
  });
});
