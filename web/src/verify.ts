/**
 * In-browser checks of what the drone signed. The same rules as
 * rollup/src/flight/segment.ts (header sign bytes) and rollup/src/util.ts
 * (canonical JSON, tagged hash): the page verifies real headers read from the
 * chain, so any drift between the two would show up as a failed check.
 */
import { sha256 } from "@noble/hashes/sha2";
import { pqcVerify } from "@qorechain/sdk";

const enc = new TextEncoder();
const dec = new TextDecoder();

export const unhex = (s: string): Uint8Array => new Uint8Array((s.replace(/^0x/, "").match(/../g) ?? []).map((b) => parseInt(b, 16)));
export const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

export const canonical = (v: unknown): string => {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
    .join(",")}}`;
};

const tagged = (tag: string, data: Uint8Array) => {
  const t = enc.encode(tag);
  const buf = new Uint8Array(t.length + 1 + data.length);
  buf.set(t);
  buf.set(data, t.length + 1);
  return sha256(buf);
};

export interface SegmentHeader {
  v: 1;
  flight: string;
  drone: string;
  idx: number;
  first: number;
  n: number;
  prev: string;
  head: string;
  body: string;
  fin: boolean;
}

/** Parse a HEADER post: "SKYH1" | u32 len | header JSON | ML-DSA-87 signature. */
export function parseHeaderPost(postHex: string): { header: SegmentHeader; signature: Uint8Array } {
  const p = unhex(postHex);
  const len = new DataView(p.buffer).getUint32(5);
  return { header: JSON.parse(dec.decode(p.subarray(9, 9 + len))), signature: p.subarray(9 + len) };
}

export const verifyHeader = (header: SegmentHeader, signature: Uint8Array, dronePublicKeyHex: string): boolean =>
  pqcVerify(unhex(dronePublicKeyHex), tagged("skyproof/segment-header/v1", enc.encode(canonical(header))), signature);
