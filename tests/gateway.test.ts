import { afterEach, describe, expect, it } from "vitest";
import { GatewayError } from "@/lib/errors";
import { MockAdapter, resolveProvider } from "@/lib/providers";
import { chatRequestSchema, parseOrThrow } from "@/lib/validation";

const valid = {
  app_id: "hr-assistant",
  user_id: "u1",
  model: "claude-sonnet-5-5",
  messages: [{ role: "user", content: "hello" }],
};

describe("chat request validation", () => {
  it("accepts a well-formed request", () => {
    expect(parseOrThrow(chatRequestSchema, valid)).toEqual(valid);
  });

  it.each([
    ["missing app_id", { ...valid, app_id: undefined }],
    ["path-like app_id", { ...valid, app_id: "../etc" }],
    ["empty messages", { ...valid, messages: [] }],
    ["no user message", { ...valid, messages: [{ role: "system", content: "x" }] }],
    ["unknown role", { ...valid, messages: [{ role: "tool", content: "x" }] }],
    ["unexpected field", { ...valid, temperature: 2 }],
  ])("rejects %s with a 400", (_name, body) => {
    try {
      parseOrThrow(chatRequestSchema, body);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(GatewayError);
      expect((err as GatewayError).status).toBe(400);
      expect((err as GatewayError).code).toBe("invalid_request");
    }
  });
});

describe("provider resolution", () => {
  const saved = { a: process.env.ANTHROPIC_API_KEY, o: process.env.OPENAI_API_KEY };
  afterEach(() => {
    if (saved.a === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved.a;
    if (saved.o === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = saved.o;
  });

  it("falls back to the mock when the provider has no API key", () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    expect(resolveProvider("claude-sonnet-5-5")).toMatchObject({ provider: "anthropic", mock: true });
    expect(resolveProvider("gpt-4o-mini")).toMatchObject({ provider: "openai", mock: true });
  });

  it("uses the real adapter when a key is present", () => {
    process.env.ANTHROPIC_API_KEY = "test-key-not-real";
    const resolved = resolveProvider("claude-haiku-4-5");
    expect(resolved.mock).toBe(false);
    expect(resolved.adapter.name).toBe("anthropic");
  });

  it("rejects models no provider serves", () => {
    expect(() => resolveProvider("llama-3")).toThrowError(/No provider is registered/);
  });
});

describe("mock adapter", () => {
  it("returns a deterministic reply with token counts and never needs a key", async () => {
    const mock = new MockAdapter(false);
    const req = {
      model: "claude-sonnet-5-5",
      messages: [{ role: "user" as const, content: "ping" }],
      maxOutputTokens: 100,
    };
    const a = await mock.chat(req);
    const b = await mock.chat(req);
    expect(a).toEqual(b);
    expect(a.text).toContain("ping");
    expect(a.inputTokens).toBeGreaterThan(0);
    expect(a.outputTokens).toBeGreaterThan(0);
  });
});
