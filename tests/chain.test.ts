import { asc } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex } from "@/lib/audit/canonical";
import { appendRecord, countRecentRequests, GENESIS_HASH, hashRecord } from "@/lib/audit/chain";
import { merkleRoot } from "@/lib/audit/merkle";
import { verifyChain } from "@/lib/audit/verify";
import { auditRecords, checkpoints, recordPayloads } from "@/lib/db/schema";
import { entry, fill, makeDb } from "./helpers";

describe("canonicalJson", () => {
  it("gives the same output regardless of key order", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: null } })).toBe(
      canonicalJson({ a: { c: null, d: [1, { y: 2, z: 1 }] }, b: 1 }),
    );
    expect(canonicalJson({ b: 1, a: "x" })).toBe('{"a":"x","b":1}');
  });

  it("keeps array order, because order is meaningful there", () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it("refuses values that have no stable JSON form", () => {
    expect(() => canonicalJson({ a: undefined })).toThrow(TypeError);
    expect(() => canonicalJson(Number.NaN)).toThrow(TypeError);
  });
});

describe("hash chain", () => {
  it("links the first record to the genesis hash", () => {
    const db = makeDb();
    const first = appendRecord(db, entry(), 50);
    expect(first.seq).toBe(1);
    expect(first.prevHash).toBe(GENESIS_HASH);
    expect(first.recordHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("links each record to the hash of the one before it", () => {
    const db = makeDb();
    const records = fill(db, 5, 50);
    for (let i = 1; i < records.length; i++) {
      expect(records[i].seq).toBe(i + 1);
      expect(records[i].prevHash).toBe(records[i - 1].recordHash);
    }
  });

  it("stores a hash that can be recomputed from the row alone", () => {
    const db = makeDb();
    fill(db, 3, 50);
    for (const row of db.select().from(auditRecords).all()) {
      const { recordHash, ...fields } = row;
      expect(hashRecord(fields)).toBe(recordHash);
    }
  });

  it("produces a different hash when any single field changes", () => {
    const db = makeDb();
    const { recordHash, ...fields } = appendRecord(db, entry(), 50);
    const changes: Partial<typeof fields>[] = [
      { seq: 2 },
      { id: "rec_other" },
      { ts: "2026-10-01T08:00:00.001Z" },
      { appId: "support-bot" },
      { userId: "u2" },
      { provider: "openai" },
      { mock: false },
      { model: "claude-haiku-4-5" },
      { decision: "BLOCK" },
      { rulesFired: '["pii:email"]' },
      { promptHash: "a".repeat(64) },
      { redactedPromptHash: "b".repeat(64) },
      { responseHash: null },
      { inputTokens: 9 },
      { outputTokens: 7 },
      { costMicros: 77 },
      { latencyMs: 211 },
      { status: "blocked" },
      { errorCode: "x" },
      { prevHash: "c".repeat(64) },
    ];
    // One change per hashed column, so a column left out of hashRecord fails here.
    expect(changes.length).toBe(Object.keys(fields).length);
    for (const change of changes) {
      expect(hashRecord({ ...fields, ...change }), JSON.stringify(change)).not.toBe(recordHash);
    }
  });

  it("stores hashes of the prompt and response, and the payload matches them", () => {
    const db = makeDb();
    const e = entry();
    const record = appendRecord(db, e, 50);
    const payload = db.select().from(recordPayloads).get();
    expect(record.redactedPromptHash).toBe(sha256Hex(e.promptRedacted));
    expect(record.responseHash).toBe(sha256Hex(e.responseText!));
    expect(payload).toEqual({ recordId: record.id, promptRedacted: e.promptRedacted, responseText: e.responseText });
  });

  it("verifies an empty log and a healthy log", () => {
    const db = makeDb();
    expect(verifyChain(db)).toEqual({ ok: true, records_checked: 0, checkpoints_checked: 0, head_hash: null });
    const records = fill(db, 10, 4);
    expect(verifyChain(db)).toEqual({
      ok: true,
      records_checked: 10,
      checkpoints_checked: 2,
      head_hash: records[9].recordHash,
    });
  });
});

describe("checkpoints", () => {
  it("writes a Merkle root every N records over exactly that batch", () => {
    const db = makeDb();
    const records = fill(db, 10, 4);
    const cps = db.select().from(checkpoints).orderBy(asc(checkpoints.toSeq)).all();
    expect(cps.map((c) => [c.fromSeq, c.toSeq])).toEqual([
      [1, 4],
      [5, 8],
    ]);
    expect(cps[0].merkleRoot).toBe(merkleRoot(records.slice(0, 4).map((r) => r.recordHash)));
    expect(cps[1].merkleRoot).toBe(merkleRoot(records.slice(4, 8).map((r) => r.recordHash)));
  });

  it("writes no checkpoint before the first batch is full", () => {
    const db = makeDb();
    fill(db, 3, 4);
    expect(db.select().from(checkpoints).all()).toEqual([]);
  });
});

describe("countRecentRequests", () => {
  it("counts only this user's requests to this app inside the window", () => {
    const db = makeDb();
    appendRecord(db, entry({ userId: "a", ts: "2026-10-01T08:00:00.000Z" }), 50);
    appendRecord(db, entry({ userId: "a", ts: "2026-10-01T08:00:30.000Z" }), 50);
    appendRecord(db, entry({ userId: "a", ts: "2026-10-01T08:01:00.000Z" }), 50);
    appendRecord(db, entry({ userId: "b", ts: "2026-10-01T08:01:00.000Z" }), 50);
    appendRecord(db, entry({ userId: "a", appId: "support-bot", ts: "2026-10-01T08:01:00.000Z" }), 50);
    expect(countRecentRequests(db, "hr-assistant", "a", "2026-10-01T08:00:30.000Z")).toBe(2);
    expect(countRecentRequests(db, "hr-assistant", "a", "2026-10-01T07:00:00.000Z")).toBe(3);
    expect(countRecentRequests(db, "hr-assistant", "nobody", "2026-10-01T07:00:00.000Z")).toBe(0);
  });
});
