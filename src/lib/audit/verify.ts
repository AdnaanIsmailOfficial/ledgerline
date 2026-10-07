import { asc, eq } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { auditRecords, checkpoints, recordPayloads } from "@/lib/db/schema";
import { sha256Hex } from "./canonical";
import { GENESIS_HASH, hashRecord } from "./chain";
import { merkleRoot } from "./merkle";

export type FailureType =
  /** A sequence number is missing: a record was deleted or reordered. */
  | "sequence_gap"
  /** A record no longer points at the hash of the record before it. */
  | "broken_link"
  /** A record's contents no longer match its stored hash: it was edited. */
  | "hash_mismatch"
  /** Stored prompt or response text no longer matches the hash in the record. */
  | "payload_mismatch"
  /** A checkpoint's Merkle root no longer matches the records it covers. */
  | "checkpoint_mismatch"
  /** A checkpoint covers records that no longer exist: the log was truncated. */
  | "checkpoint_orphaned";

export interface VerifyFailure {
  type: FailureType;
  /** The record (or the last record of the checkpoint) where the problem was found. */
  seq: number;
  record_id: string | null;
  message: string;
  expected: string | null;
  actual: string | null;
}

export type VerifyResult =
  | { ok: true; records_checked: number; checkpoints_checked: number; head_hash: string | null }
  | { ok: false; records_checked: number; checkpoints_checked: number; failure: VerifyFailure };

/**
 * Walks the whole log from the first record and stops at the first problem.
 * It trusts nothing stored in the database: every hash is recomputed from the
 * row's own contents and compared with what is stored.
 */
export function verifyChain(db: Db): VerifyResult {
  const rows = db
    .select({ record: auditRecords, payload: recordPayloads })
    .from(auditRecords)
    .leftJoin(recordPayloads, eq(recordPayloads.recordId, auditRecords.id))
    .orderBy(asc(auditRecords.seq))
    .all();

  let prevHash = GENESIS_HASH;
  let checked = 0;
  const fail = (failure: VerifyFailure): VerifyResult => ({
    ok: false,
    records_checked: checked,
    checkpoints_checked: 0,
    failure,
  });

  for (const { record, payload } of rows) {
    const expectedSeq = checked + 1;
    const { recordHash, ...fields } = record;

    if (record.seq !== expectedSeq) {
      return fail({
        type: "sequence_gap",
        seq: expectedSeq,
        record_id: null,
        message: `Record ${expectedSeq} is missing. The next record found is ${record.seq}.`,
        expected: String(expectedSeq),
        actual: String(record.seq),
      });
    }
    if (record.prevHash !== prevHash) {
      return fail({
        type: "broken_link",
        seq: record.seq,
        record_id: record.id,
        message: `Record ${record.seq} does not point at the hash of record ${record.seq - 1}.`,
        expected: prevHash,
        actual: record.prevHash,
      });
    }
    const recomputed = hashRecord(fields);
    if (recomputed !== recordHash) {
      return fail({
        type: "hash_mismatch",
        seq: record.seq,
        record_id: record.id,
        message: `Record ${record.seq} has been altered: its contents no longer match its stored hash.`,
        expected: recordHash,
        actual: recomputed,
      });
    }
    // Payload text is optional (it may have been erased), but if it is present it must match.
    if (payload) {
      const promptHash = sha256Hex(payload.promptRedacted);
      if (promptHash !== record.redactedPromptHash) {
        return fail({
          type: "payload_mismatch",
          seq: record.seq,
          record_id: record.id,
          message: `The stored prompt text for record ${record.seq} has been altered.`,
          expected: record.redactedPromptHash,
          actual: promptHash,
        });
      }
      const responseHash = payload.responseText === null ? null : sha256Hex(payload.responseText);
      if (responseHash !== record.responseHash) {
        return fail({
          type: "payload_mismatch",
          seq: record.seq,
          record_id: record.id,
          message: `The stored response text for record ${record.seq} has been altered.`,
          expected: record.responseHash,
          actual: responseHash,
        });
      }
    }

    prevHash = recordHash;
    checked += 1;
  }

  // Second pass: every checkpoint root must still match the records it covers.
  // This catches an attacker who edits a record and then carefully recomputes
  // every hash after it, because the roots were fixed before the edit.
  const hashes = rows.map((r) => r.record.recordHash);
  const allCheckpoints = db.select().from(checkpoints).orderBy(asc(checkpoints.toSeq)).all();
  let checkpointsChecked = 0;
  for (const cp of allCheckpoints) {
    const failCp = (type: FailureType, message: string, actual: string | null): VerifyResult => ({
      ok: false,
      records_checked: checked,
      checkpoints_checked: checkpointsChecked,
      failure: {
        type,
        seq: cp.toSeq,
        record_id: rows[cp.toSeq - 1]?.record.id ?? null,
        message,
        expected: cp.merkleRoot,
        actual,
      },
    });
    if (cp.fromSeq < 1 || cp.fromSeq > cp.toSeq || cp.toSeq > hashes.length) {
      return failCp(
        "checkpoint_orphaned",
        `Checkpoint ${cp.id} covers records ${cp.fromSeq} to ${cp.toSeq}, but the log only has ${hashes.length} records.`,
        null,
      );
    }
    const root = merkleRoot(hashes.slice(cp.fromSeq - 1, cp.toSeq));
    if (root !== cp.merkleRoot) {
      return failCp(
        "checkpoint_mismatch",
        `Checkpoint ${cp.id} no longer matches records ${cp.fromSeq} to ${cp.toSeq}.`,
        root,
      );
    }
    checkpointsChecked += 1;
  }

  return {
    ok: true,
    records_checked: checked,
    checkpoints_checked: checkpointsChecked,
    head_hash: hashes.length > 0 ? hashes[hashes.length - 1] : null,
  };
}
