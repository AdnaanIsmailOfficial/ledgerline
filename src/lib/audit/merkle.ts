import { createHash } from "node:crypto";

/**
 * Merkle tree in the style of RFC 6962 (Certificate Transparency).
 *
 * Leaves and internal nodes are hashed with different prefixes (0x00 and 0x01)
 * so an internal node can never be passed off as a leaf. When a level has an
 * odd number of nodes the tree is split at the largest power of two, instead
 * of duplicating the last node, which avoids the well-known weakness where two
 * different lists of leaves produce the same root.
 */

export interface ProofStep {
  /** Which side of the running hash this sibling sits on. */
  position: "left" | "right";
  hash: string;
}

function sha256(...parts: Buffer[]): Buffer {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return h.digest();
}

const LEAF_PREFIX = Buffer.from([0x00]);
const NODE_PREFIX = Buffer.from([0x01]);

const leafHash = (leafHex: string) => sha256(LEAF_PREFIX, Buffer.from(leafHex, "hex"));
const nodeHash = (left: Buffer, right: Buffer) => sha256(NODE_PREFIX, left, right);

/** Largest power of two strictly less than n (n must be at least 2). */
function splitPoint(n: number): number {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

function rootOf(leaves: string[]): Buffer {
  if (leaves.length === 1) return leafHash(leaves[0]);
  const k = splitPoint(leaves.length);
  return nodeHash(rootOf(leaves.slice(0, k)), rootOf(leaves.slice(k)));
}

function assertLeaves(leaves: string[]): void {
  if (leaves.length === 0) throw new RangeError("A Merkle tree needs at least one leaf");
  for (const leaf of leaves) {
    if (!/^[0-9a-f]{64}$/.test(leaf)) throw new TypeError(`Leaf is not a SHA-256 hex digest: ${leaf}`);
  }
}

/** Root over a list of SHA-256 hex digests (the record hashes). */
export function merkleRoot(leaves: string[]): string {
  assertLeaves(leaves);
  return rootOf(leaves).toString("hex");
}

/** The sibling hashes needed to recompute the root from the leaf at `index`. */
export function merkleProof(leaves: string[], index: number): ProofStep[] {
  assertLeaves(leaves);
  if (!Number.isInteger(index) || index < 0 || index >= leaves.length) {
    throw new RangeError(`Leaf index ${index} is outside a tree of ${leaves.length} leaves`);
  }
  if (leaves.length === 1) return [];
  const k = splitPoint(leaves.length);
  if (index < k) {
    return [
      ...merkleProof(leaves.slice(0, k), index),
      { position: "right", hash: rootOf(leaves.slice(k)).toString("hex") },
    ];
  }
  return [
    ...merkleProof(leaves.slice(k), index - k),
    { position: "left", hash: rootOf(leaves.slice(0, k)).toString("hex") },
  ];
}

/**
 * Recomputes the root from one leaf and its proof. Needs nothing but the
 * arguments, so anyone holding a trusted root can run it without database access.
 */
export function verifyMerkleProof(leaf: string, proof: ProofStep[], expectedRoot: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(leaf)) return false;
  let running = leafHash(leaf);
  for (const step of proof) {
    if (!/^[0-9a-f]{64}$/.test(step.hash)) return false;
    const sibling = Buffer.from(step.hash, "hex");
    running = step.position === "right" ? nodeHash(running, sibling) : nodeHash(sibling, running);
  }
  return running.toString("hex") === expectedRoot;
}
