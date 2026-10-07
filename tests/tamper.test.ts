import { asc } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { hashRecord } from "@/lib/audit/chain";
import { merkleRoot } from "@/lib/audit/merkle";
import { verifyChain } from "@/lib/audit/verify";
import type { Db } from "@/lib/db/client";
import { auditRecords, type AuditRecord } from "@/lib/db/schema";
import { fill, makeDb, rawSql } from "./helpers";

// 10 records with a checkpoint every 4: records 1-8 are covered by two
// checkpoints, records 9 and 10 are the un-checkpointed tail.
let db: Db;
let records: AuditRecord[];
beforeEach(() => {
  db = makeDb();
  records = fill(db, 10, 4);
});

function expectFailure(type: string, seq: number) {
  const result = verifyChain(db);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("unreachable");
  expect(result.failure.type).toBe(type);
  expect(result.failure.seq).toBe(seq);
  return result;
}

/** Recomputes prev_hash and record_hash for every record from `fromSeq` on, as a careful attacker would. */
function rewriteChainFrom(fromSeq: number) {
  const rows = db.select().from(auditRecords).orderBy(asc(auditRecords.seq)).all();
  let prev = rows[fromSeq - 2]?.recordHash ?? "0".repeat(64);
  for (const row of rows.slice(fromSeq - 1)) {
    const { recordHash: _old, ...fields } = row;
    const next = hashRecord({ ...fields, prevHash: prev });
    rawSql(db, "UPDATE audit_records SET prev_hash = ?, record_hash = ? WHERE seq = ?", prev, next, row.seq);
    prev = next;
  }
}

describe("tamper detection", () => {
  it("passes before anything is touched", () => {
    expect(verifyChain(db).ok).toBe(true);
  });

  it.each([
    ["decision", "BLOCK"],
    ["user_id", "someone-else"],
    ["model", "gpt-4o"],
    ["rules_fired", '["pii:email"]'],
    ["ts", "2020-01-01T00:00:00.000Z"],
    ["cost_micros", 0],
    ["input_tokens", 1],
    ["prompt_hash", "f".repeat(64)],
    ["response_hash", "f".repeat(64)],
    ["status", "blocked"],
    ["mock", 0],
  ])("detects an edit to %s and names the exact record", (column, value) => {
    rawSql(db, `UPDATE audit_records SET ${column} = ? WHERE seq = 6`, value);
    const result = expectFailure("hash_mismatch", 6);
    if (!result.ok) {
      expect(result.failure.record_id).toBe(records[5].id);
      expect(result.records_checked).toBe(5);
    }
  });

  it("detects an edit to the very first and very last record", () => {
    rawSql(db, "UPDATE audit_records SET decision = 'BLOCK' WHERE seq = 10");
    expectFailure("hash_mismatch", 10);
    rawSql(db, "UPDATE audit_records SET decision = 'BLOCK' WHERE seq = 1");
    expectFailure("hash_mismatch", 1);
  });

  it("detects a record whose hash was recomputed to hide an edit, at the next record", () => {
    const { recordHash: _old, ...fields } = records[5];
    const forged = hashRecord({ ...fields, decision: "BLOCK" });
    rawSql(db, "UPDATE audit_records SET decision = 'BLOCK', record_hash = ? WHERE seq = 6", forged);
    expectFailure("broken_link", 7);
  });

  it("detects a deleted record", () => {
    rawSql(db, "DELETE FROM record_payloads WHERE record_id = ?", records[4].id);
    rawSql(db, "DELETE FROM audit_records WHERE seq = 5");
    expectFailure("sequence_gap", 5);
  });

  it("detects a full chain rewrite when the edit is under a checkpoint", () => {
    rawSql(db, "UPDATE audit_records SET decision = 'BLOCK' WHERE seq = 6");
    rewriteChainFrom(6);
    // Every link is now consistent again, but checkpoint 2 was fixed before the edit.
    expectFailure("checkpoint_mismatch", 8);
  });

  it("detects a rewritten chain even when the checkpoint is edited too, if an earlier root is known", () => {
    rawSql(db, "UPDATE audit_records SET decision = 'BLOCK' WHERE seq = 6");
    rewriteChainFrom(6);
    const hashes = db.select().from(auditRecords).orderBy(asc(auditRecords.seq)).all().map((r) => r.recordHash);
    rawSql(db, "UPDATE checkpoints SET merkle_root = ? WHERE to_seq = 8", merkleRoot(hashes.slice(4, 8)));
    // Internally consistent again: the database alone can no longer tell. This is
    // exactly why roots should be anchored somewhere the attacker cannot write.
    const result = verifyChain(db);
    expect(result.ok).toBe(true);
    const originalRoot = merkleRoot(records.slice(4, 8).map((r) => r.recordHash));
    expect(merkleRoot(hashes.slice(4, 8))).not.toBe(originalRoot);
  });

  it("documents the limit: a full rewrite of the un-checkpointed tail is not detectable", () => {
    rawSql(db, "UPDATE audit_records SET decision = 'BLOCK' WHERE seq = 9");
    rewriteChainFrom(9);
    expect(verifyChain(db).ok).toBe(true);
  });

  it("detects a truncated log once a checkpoint covers the removed records", () => {
    for (const r of records.slice(6)) rawSql(db, "DELETE FROM record_payloads WHERE record_id = ?", r.id);
    rawSql(db, "DELETE FROM audit_records WHERE seq > 6");
    expectFailure("checkpoint_orphaned", 8);
  });

  it("detects an edited checkpoint root", () => {
    rawSql(db, "UPDATE checkpoints SET merkle_root = ? WHERE to_seq = 4", "a".repeat(64));
    expectFailure("checkpoint_mismatch", 4);
  });

  it("detects edited prompt or response text", () => {
    rawSql(db, "UPDATE record_payloads SET response_text = 'You have 40 days left.' WHERE record_id = ?", records[2].id);
    expectFailure("payload_mismatch", 3);
    rawSql(db, "UPDATE record_payloads SET prompt_redacted = '[]' WHERE record_id = ?", records[1].id);
    expectFailure("payload_mismatch", 2);
  });

  it("still verifies after payload text is erased, because the chain only holds hashes", () => {
    rawSql(db, "DELETE FROM record_payloads WHERE record_id = ?", records[2].id);
    expect(verifyChain(db).ok).toBe(true);
  });
});
