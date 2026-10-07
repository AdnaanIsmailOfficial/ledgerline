import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "@/lib/audit/canonical";
import { merkleProof, merkleRoot, verifyMerkleProof } from "@/lib/audit/merkle";
import { buildInclusionProof } from "@/lib/audit/proof";
import { GatewayError } from "@/lib/errors";
import { fill, makeDb, rawSql } from "./helpers";

const leaves = (n: number) => Array.from({ length: n }, (_, i) => sha256Hex(`leaf-${i}`));
const sha = (...parts: Buffer[]) => parts.reduce((h, p) => h.update(p), createHash("sha256")).digest();

describe("merkleRoot", () => {
  it("hashes a single leaf with the leaf prefix", () => {
    const [leaf] = leaves(1);
    expect(merkleRoot([leaf])).toBe(sha(Buffer.from([0]), Buffer.from(leaf, "hex")).toString("hex"));
  });

  it("matches a hand-built three-leaf tree, split at the largest power of two", () => {
    const [a, b, c] = leaves(3).map((l) => sha(Buffer.from([0]), Buffer.from(l, "hex")));
    const ab = sha(Buffer.from([1]), a, b);
    expect(merkleRoot(leaves(3))).toBe(sha(Buffer.from([1]), ab, c).toString("hex"));
  });

  it("changes when any leaf changes or leaves are reordered", () => {
    const base = leaves(8);
    const root = merkleRoot(base);
    expect(merkleRoot(base.with(3, sha256Hex("other")))).not.toBe(root);
    expect(merkleRoot([base[1], base[0], ...base.slice(2)])).not.toBe(root);
  });

  it("does not let a duplicated last leaf produce the same root", () => {
    const [a, b, c] = leaves(3);
    expect(merkleRoot([a, b, c])).not.toBe(merkleRoot([a, b, c, c]));
  });

  it("rejects an empty tree and malformed leaves", () => {
    expect(() => merkleRoot([])).toThrow(RangeError);
    expect(() => merkleRoot(["not-a-hash"])).toThrow(TypeError);
  });
});

describe("merkle proofs", () => {
  it("verifies a proof for every leaf in trees of 1 to 33 leaves", () => {
    for (let n = 1; n <= 33; n++) {
      const tree = leaves(n);
      const root = merkleRoot(tree);
      for (let i = 0; i < n; i++) {
        const proof = merkleProof(tree, i);
        expect(verifyMerkleProof(tree[i], proof, root), `n=${n} i=${i}`).toBe(true);
        expect(proof.length).toBeLessThanOrEqual(Math.ceil(Math.log2(n)));
      }
    }
  });

  it("needs only 6 hashes to prove membership in a batch of 50", () => {
    expect(Math.max(...leaves(50).map((_, i, all) => merkleProof(all, i).length))).toBe(6);
  });

  it("fails for a different leaf, a different root or the wrong position", () => {
    const tree = leaves(13);
    const root = merkleRoot(tree);
    const proof = merkleProof(tree, 5);
    expect(verifyMerkleProof(tree[6], proof, root)).toBe(false);
    expect(verifyMerkleProof(tree[5], proof, merkleRoot(leaves(12)))).toBe(false);
    expect(verifyMerkleProof(tree[5], merkleProof(tree, 6), root)).toBe(false);
  });

  it("fails if any step of the proof is altered", () => {
    const tree = leaves(13);
    const root = merkleRoot(tree);
    const proof = merkleProof(tree, 5);
    proof.forEach((step, i) => {
      const badHash = proof.with(i, { ...step, hash: sha256Hex("forged") });
      const flipped = proof.with(i, { ...step, position: step.position === "left" ? "right" : "left" } as const);
      expect(verifyMerkleProof(tree[5], badHash, root)).toBe(false);
      expect(verifyMerkleProof(tree[5], flipped, root)).toBe(false);
    });
    expect(verifyMerkleProof(tree[5], proof.slice(1), root)).toBe(false);
    expect(verifyMerkleProof(tree[5], [...proof, proof[0]], root)).toBe(false);
  });

  it("does not accept an internal node as if it were a leaf", () => {
    const tree = leaves(4);
    const root = merkleRoot(tree);
    const leftSubtreeRoot = merkleRoot(tree.slice(0, 2));
    const rightSubtreeRoot = merkleRoot(tree.slice(2));
    expect(verifyMerkleProof(leftSubtreeRoot, [{ position: "right", hash: rightSubtreeRoot }], root)).toBe(false);
  });

  it("rejects an out-of-range index", () => {
    expect(() => merkleProof(leaves(4), 4)).toThrow(RangeError);
    expect(() => merkleProof(leaves(4), -1)).toThrow(RangeError);
  });
});

describe("buildInclusionProof", () => {
  it("returns a proof that verifies against the stored checkpoint root", () => {
    const db = makeDb();
    const records = fill(db, 10, 4);
    for (const record of records.slice(0, 8)) {
      const p = buildInclusionProof(db, record.id, 4);
      expect(p.status).toBe("included");
      if (p.status !== "included") continue;
      expect(p.verified).toBe(true);
      expect(p.tree_size).toBe(4);
      expect(p.leaf_index).toBe((record.seq - 1) % 4);
      // The proof stands on its own: leaf + steps + root, no database needed.
      expect(verifyMerkleProof(p.record_hash, p.proof, p.checkpoint.merkle_root)).toBe(true);
    }
  });

  it("reports records in an unfinished batch as pending", () => {
    const db = makeDb();
    const records = fill(db, 10, 4);
    expect(buildInclusionProof(db, records[8].id, 4)).toMatchObject({ status: "pending", seq: 9, records_until_checkpoint: 3 });
    expect(buildInclusionProof(db, records[9].id, 4)).toMatchObject({ status: "pending", seq: 10, records_until_checkpoint: 2 });
  });

  it("reports verified: false when a record under the checkpoint was altered", () => {
    const db = makeDb();
    const records = fill(db, 8, 4);
    rawSql(db, "UPDATE audit_records SET record_hash = ? WHERE seq = 2", "e".repeat(64));
    const proofForNeighbour = buildInclusionProof(db, records[0].id, 4);
    expect(proofForNeighbour).toMatchObject({ status: "included", verified: false });
  });

  it("returns 404 for an unknown record", () => {
    try {
      buildInclusionProof(makeDb(), "rec_missing", 4);
      expect.unreachable();
    } catch (err) {
      expect((err as GatewayError).status).toBe(404);
    }
  });
});
