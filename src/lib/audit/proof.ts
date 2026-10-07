import { and, asc, between, eq, gte, lte } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { auditRecords, checkpoints } from "@/lib/db/schema";
import { GatewayError } from "@/lib/errors";
import { merkleProof, verifyMerkleProof, type ProofStep } from "./merkle";

export type InclusionProof =
  | {
      status: "included";
      record_id: string;
      seq: number;
      record_hash: string;
      checkpoint: {
        id: number;
        from_seq: number;
        to_seq: number;
        merkle_root: string;
        anchor_tx_hash: string | null;
        anchor_chain: string | null;
      };
      /** Position of the record inside the checkpoint's batch, starting at 0. */
      leaf_index: number;
      tree_size: number;
      proof: ProofStep[];
      /** False if the records under this checkpoint no longer hash to its stored root. */
      verified: boolean;
    }
  | {
      status: "pending";
      record_id: string;
      seq: number;
      record_hash: string;
      /** The record is in the hash chain but its batch has not been checkpointed yet. */
      records_until_checkpoint: number;
    };

export function buildInclusionProof(db: Db, recordId: string, checkpointInterval: number): InclusionProof {
  const record = db
    .select({ seq: auditRecords.seq, id: auditRecords.id, recordHash: auditRecords.recordHash })
    .from(auditRecords)
    .where(eq(auditRecords.id, recordId))
    .get();
  if (!record) throw new GatewayError(404, "record_not_found", `No audit record with id "${recordId}"`);

  const cp = db
    .select()
    .from(checkpoints)
    .where(and(lte(checkpoints.fromSeq, record.seq), gte(checkpoints.toSeq, record.seq)))
    .get();
  if (!cp) {
    return {
      status: "pending",
      record_id: record.id,
      seq: record.seq,
      record_hash: record.recordHash,
      records_until_checkpoint: checkpointInterval - (record.seq % checkpointInterval),
    };
  }

  const leaves = db
    .select({ recordHash: auditRecords.recordHash })
    .from(auditRecords)
    .where(between(auditRecords.seq, cp.fromSeq, cp.toSeq))
    .orderBy(asc(auditRecords.seq))
    .all()
    .map((r) => r.recordHash);
  const leafIndex = record.seq - cp.fromSeq;
  if (leafIndex >= leaves.length) {
    throw new GatewayError(409, "checkpoint_incomplete", `Records under checkpoint ${cp.id} are missing; run /api/v1/verify`);
  }
  const proof = merkleProof(leaves, leafIndex);

  return {
    status: "included",
    record_id: record.id,
    seq: record.seq,
    record_hash: record.recordHash,
    checkpoint: {
      id: cp.id,
      from_seq: cp.fromSeq,
      to_seq: cp.toSeq,
      merkle_root: cp.merkleRoot,
      anchor_tx_hash: cp.anchorTxHash,
      anchor_chain: cp.anchorChain,
    },
    leaf_index: leafIndex,
    tree_size: leaves.length,
    proof,
    verified: verifyMerkleProof(record.recordHash, proof, cp.merkleRoot),
  };
}
