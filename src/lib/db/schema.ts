import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * The append-only, hash-chained audit log. One row per request that reached
 * the policy engine, including blocked requests and provider failures.
 *
 * Every column except record_hash is an input to record_hash, so changing any
 * value in a row is detectable. See src/lib/audit/chain.ts.
 */
export const auditRecords = sqliteTable(
  "audit_records",
  {
    /** Position in the chain, starting at 1 with no gaps. */
    seq: integer("seq").primaryKey(),
    /** Public identifier, used in /api/v1/proof/:recordId. */
    id: text("id").notNull().unique(),
    ts: text("ts").notNull(),
    appId: text("app_id").notNull(),
    userId: text("user_id").notNull(),
    provider: text("provider").notNull(),
    /** True when the built-in mock answered because no API key was configured. */
    mock: integer("mock", { mode: "boolean" }).notNull(),
    model: text("model").notNull(),
    decision: text("decision", { enum: ["ALLOW", "REDACT", "BLOCK"] }).notNull(),
    /** JSON array of rule ids, for example ["pii:email"]. */
    rulesFired: text("rules_fired").notNull(),
    /** SHA-256 of the prompt as the caller sent it. The raw original is never stored. */
    promptHash: text("prompt_hash").notNull(),
    /** SHA-256 of the prompt after PII redaction, which is the stored payload. */
    redactedPromptHash: text("redacted_prompt_hash").notNull(),
    /** SHA-256 of the model's response. Null when nothing came back. */
    responseHash: text("response_hash"),
    inputTokens: integer("input_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    /** Estimated cost in millionths of a US dollar. */
    costMicros: integer("cost_micros").notNull(),
    latencyMs: integer("latency_ms").notNull(),
    status: text("status", { enum: ["ok", "blocked", "provider_error"] }).notNull(),
    errorCode: text("error_code"),
    /** record_hash of the previous row. The first row points at 64 zeros. */
    prevHash: text("prev_hash").notNull(),
    recordHash: text("record_hash").notNull(),
  },
  (t) => [
    index("idx_audit_app_user_ts").on(t.appId, t.userId, t.ts),
    index("idx_audit_ts").on(t.ts),
  ],
);

/**
 * Human-readable text, kept outside the hash chain on purpose. A row here can
 * be deleted (for example for a data-erasure request) without breaking
 * verification, because the chain only commits to the hashes of this text.
 */
export const recordPayloads = sqliteTable("record_payloads", {
  recordId: text("record_id")
    .primaryKey()
    .references(() => auditRecords.id),
  /** Canonical JSON of the redacted messages. Hashes to redacted_prompt_hash. */
  promptRedacted: text("prompt_redacted").notNull(),
  /** Hashes to response_hash. */
  responseText: text("response_text"),
});

/** A Merkle root over a fixed-size batch of consecutive record hashes. */
export const checkpoints = sqliteTable("checkpoints", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  fromSeq: integer("from_seq").notNull(),
  toSeq: integer("to_seq").notNull().unique(),
  merkleRoot: text("merkle_root").notNull(),
  createdAt: text("created_at").notNull(),
  /** Filled in only if the root is anchored to a public chain. */
  anchorTxHash: text("anchor_tx_hash"),
  anchorChain: text("anchor_chain"),
});

export type AuditRecord = typeof auditRecords.$inferSelect;
export type Checkpoint = typeof checkpoints.$inferSelect;
