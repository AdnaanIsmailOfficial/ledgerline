import { randomUUID } from "node:crypto";
import { and, asc, between, desc, eq, gte, sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { auditRecords, checkpoints, recordPayloads, type AuditRecord } from "@/lib/db/schema";
import { canonicalJson, sha256Hex } from "./canonical";
import { merkleRoot } from "./merkle";

/** What the first record's prev_hash points at. */
export const GENESIS_HASH = "0".repeat(64);

/** The columns a record's hash commits to: everything except record_hash itself. */
export type HashedFields = Omit<AuditRecord, "recordHash">;

/**
 * SHA-256 over the canonical JSON of the record. Fields are listed one by one
 * so adding a column later cannot silently change old hashes; `v` lets a
 * future format be told apart from this one.
 */
export function hashRecord(r: HashedFields): string {
  return sha256Hex(
    canonicalJson({
      v: 1,
      seq: r.seq,
      id: r.id,
      ts: r.ts,
      app_id: r.appId,
      user_id: r.userId,
      provider: r.provider,
      mock: r.mock,
      model: r.model,
      decision: r.decision,
      rules_fired: r.rulesFired,
      prompt_hash: r.promptHash,
      redacted_prompt_hash: r.redactedPromptHash,
      response_hash: r.responseHash,
      input_tokens: r.inputTokens,
      output_tokens: r.outputTokens,
      cost_micros: r.costMicros,
      latency_ms: r.latencyMs,
      status: r.status,
      error_code: r.errorCode,
      prev_hash: r.prevHash,
    }),
  );
}

export interface NewEntry {
  ts: string;
  appId: string;
  userId: string;
  provider: string;
  mock: boolean;
  model: string;
  decision: AuditRecord["decision"];
  rulesFired: string[];
  /** Hash of the caller's original messages. The messages themselves are not passed in. */
  promptHash: string;
  /** Canonical JSON of the redacted messages. Stored as the payload and hashed. */
  promptRedacted: string;
  responseText: string | null;
  inputTokens: number;
  outputTokens: number;
  costMicros: number;
  latencyMs: number;
  status: AuditRecord["status"];
  errorCode: string | null;
}

/**
 * Appends one record to the chain.
 *
 * Reading the current head and inserting the new record happen inside a single
 * IMMEDIATE transaction, which takes SQLite's write lock up front. Two requests
 * finishing at the same moment therefore cannot both read the same head and
 * fork the chain.
 */
export function appendRecord(db: Db, entry: NewEntry, checkpointInterval: number): AuditRecord {
  return db.transaction(
    (tx) => {
      const head = tx
        .select({ seq: auditRecords.seq, recordHash: auditRecords.recordHash })
        .from(auditRecords)
        .orderBy(desc(auditRecords.seq))
        .limit(1)
        .get();

      const fields: HashedFields = {
        seq: (head?.seq ?? 0) + 1,
        id: `rec_${randomUUID()}`,
        ts: entry.ts,
        appId: entry.appId,
        userId: entry.userId,
        provider: entry.provider,
        mock: entry.mock,
        model: entry.model,
        decision: entry.decision,
        rulesFired: JSON.stringify(entry.rulesFired),
        promptHash: entry.promptHash,
        redactedPromptHash: sha256Hex(entry.promptRedacted),
        responseHash: entry.responseText === null ? null : sha256Hex(entry.responseText),
        inputTokens: entry.inputTokens,
        outputTokens: entry.outputTokens,
        costMicros: entry.costMicros,
        latencyMs: entry.latencyMs,
        status: entry.status,
        errorCode: entry.errorCode,
        prevHash: head?.recordHash ?? GENESIS_HASH,
      };
      const record: AuditRecord = { ...fields, recordHash: hashRecord(fields) };

      tx.insert(auditRecords).values(record).run();
      tx.insert(recordPayloads)
        .values({ recordId: record.id, promptRedacted: entry.promptRedacted, responseText: entry.responseText })
        .run();

      // Close a checkpoint in the same transaction, so a full batch of records
      // can never exist without its Merkle root.
      if (record.seq % checkpointInterval === 0) {
        const fromSeq = record.seq - checkpointInterval + 1;
        const leaves = tx
          .select({ recordHash: auditRecords.recordHash })
          .from(auditRecords)
          .where(between(auditRecords.seq, fromSeq, record.seq))
          .orderBy(asc(auditRecords.seq))
          .all()
          .map((r) => r.recordHash);
        tx.insert(checkpoints)
          .values({ fromSeq, toSeq: record.seq, merkleRoot: merkleRoot(leaves), createdAt: entry.ts })
          .run();
      }

      return record;
    },
    { behavior: "immediate" },
  );
}

/** How many requests this user has made to this app since `sinceIso`, for rate limiting. */
export function countRecentRequests(db: Db, appId: string, userId: string, sinceIso: string): number {
  const row = db
    .select({ n: sql<number>`count(*)` })
    .from(auditRecords)
    .where(and(eq(auditRecords.appId, appId), eq(auditRecords.userId, userId), gte(auditRecords.ts, sinceIso)))
    .get();
  return row?.n ?? 0;
}
