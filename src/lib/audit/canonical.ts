import { createHash } from "node:crypto";

/**
 * JSON with object keys sorted and no whitespace, so the same data always
 * serialises to the same bytes and therefore the same hash. Plain
 * JSON.stringify is not safe for hashing because key order follows insertion.
 */
export function canonicalJson(value: unknown): string {
  if (value === undefined) throw new TypeError("canonicalJson cannot serialise undefined");
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new TypeError("canonicalJson cannot serialise a non-finite number");
  }
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const members = Object.keys(obj)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(obj[key])}`);
  return `{${members.join(",")}}`;
}

export function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}
