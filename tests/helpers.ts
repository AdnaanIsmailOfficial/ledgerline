import { canonicalJson, sha256Hex } from "@/lib/audit/canonical";
import { appendRecord, type NewEntry } from "@/lib/audit/chain";
import { openDb, type Db } from "@/lib/db/client";

export function makeDb(): Db {
  return openDb(":memory:");
}

export function entry(overrides: Partial<NewEntry> = {}): NewEntry {
  const messages = [{ role: "user", content: "How many leave days do I have?" }];
  return {
    ts: "2026-10-01T08:00:00.000Z",
    appId: "hr-assistant",
    userId: "u1",
    provider: "anthropic",
    mock: true,
    model: "claude-sonnet-5-5",
    decision: "ALLOW",
    rulesFired: [],
    promptHash: sha256Hex(canonicalJson(messages)),
    promptRedacted: canonicalJson(messages),
    responseText: "You have 12 days left.",
    inputTokens: 8,
    outputTokens: 6,
    costMicros: 76,
    latencyMs: 210,
    status: "ok",
    errorCode: null,
    ...overrides,
  };
}

/** Appends `count` records with distinct users and increasing timestamps. */
export function fill(db: Db, count: number, checkpointInterval = 4) {
  const base = Date.parse("2026-10-01T08:00:00.000Z");
  return Array.from({ length: count }, (_, i) =>
    appendRecord(db, entry({ userId: `u${i}`, ts: new Date(base + i * 1000).toISOString() }), checkpointInterval),
  );
}

/** Direct SQL access, standing in for an attacker with write access to the database file. */
export function rawSql(db: Db, sql: string, ...params: unknown[]) {
  return db.$client.prepare(sql).run(...params);
}
