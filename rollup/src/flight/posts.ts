/**
 * The other SkyProof posts in the rollup inbox (besides segment BODY/HEADER):
 *
 *   DRONE  "SKYD1" | json {drone, permit}  | u32 len | ML-DSA-87 public key
 *          The operator registers a drone and its permit. Only a post by the
 *          rollup's creator counts.
 *   CLAIM  "SKYC1" | json {flight, note, when?, where?, evidence?}
 *          A victim reports harm from a flight. The poster address is the payee.
 *          Filed in one transaction with a 1 QOR deposit into the claims pool.
 *          `evidence` is the SHA-256 of a photo the victim keeps, so the file
 *          they later show the insurer is provably the one they filed.
 *   DECIDE "SKYI1" | json {flight, victim, approve, reason}
 *          The insurer's decision on a claim the rules sent to review. Only a
 *          post by the insurer's address counts.
 *   EXIT   "SKYX1" | json {amount}
 *          The operator asks for its bond back.
 *
 * None of these is a qledger transaction, so the ledger skips them.
 */
import { concat, dec, enc, equalBytes, readU32, u32 } from "../util.js";
import type { Permit } from "../rules.js";

export const DRONE_MAGIC = enc.encode("SKYD1");
export const CLAIM_MAGIC = enc.encode("SKYC1");
export const EXIT_MAGIC = enc.encode("SKYX1");
export const DECIDE_MAGIC = enc.encode("SKYI1");

const has = (p: Uint8Array, m: Uint8Array) => p.length >= m.length && equalBytes(p.subarray(0, m.length), m);

export interface DroneReg {
  drone: string;
  permit: Permit;
}
export function droneRegPost(reg: DroneReg, publicKey: Uint8Array): Uint8Array {
  const json = enc.encode(JSON.stringify(reg));
  return concat(DRONE_MAGIC, u32(json.length), json, publicKey);
}
export function parseDroneReg(p: Uint8Array): (DroneReg & { publicKey: Uint8Array }) | undefined {
  if (!has(p, DRONE_MAGIC)) return undefined;
  const len = readU32(p, DRONE_MAGIC.length);
  const s = DRONE_MAGIC.length + 4;
  return { ...(JSON.parse(dec.decode(p.subarray(s, s + len))) as DroneReg), publicKey: p.slice(s + len) };
}

/** Parse the JSON after `magic`; undefined for anything malformed (anyone can post to the inbox). */
function body(p: Uint8Array, magic: Uint8Array): Record<string, unknown> | undefined {
  if (!has(p, magic)) return undefined;
  try {
    const v = JSON.parse(dec.decode(p.subarray(magic.length)));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}
const str = (v: unknown, max: number) => (typeof v === "string" && v.length <= max ? v : undefined);

export interface Claim {
  flight: string;
  note: string;
  /** When it happened, as the victim reports it (free text, e.g. an ISO time). */
  when?: string;
  /** Where it happened (free text). */
  where?: string;
  /** SHA-256 (hex) of a photo the victim keeps as evidence. */
  evidence?: string;
}
export const claimPost = (c: Claim) => concat(CLAIM_MAGIC, enc.encode(JSON.stringify(c)));
export function parseClaim(p: Uint8Array): Claim | undefined {
  const j = body(p, CLAIM_MAGIC);
  const flight = str(j?.flight, 128);
  if (!j || !flight) return undefined;
  const evidence = str(j.evidence, 64);
  return {
    flight,
    note: str(j.note, 1000) ?? "",
    ...(str(j.when, 64) ? { when: str(j.when, 64) } : {}),
    ...(str(j.where, 200) ? { where: str(j.where, 200) } : {}),
    ...(evidence && /^[0-9a-f]{64}$/.test(evidence) ? { evidence } : {}),
  };
}

export interface Decision {
  flight: string;
  victim: string;
  approve: boolean;
  reason: string;
}
export const decisionPost = (d: Decision) => concat(DECIDE_MAGIC, enc.encode(JSON.stringify(d)));
export function parseDecision(p: Uint8Array): Decision | undefined {
  const j = body(p, DECIDE_MAGIC);
  const flight = str(j?.flight, 128);
  const victim = str(j?.victim, 90);
  if (!j || !flight || !victim || typeof j.approve !== "boolean") return undefined;
  return { flight, victim, approve: j.approve, reason: str(j.reason, 1000) ?? "" };
}

export const exitPost = (amountUqor: bigint) => concat(EXIT_MAGIC, enc.encode(JSON.stringify({ amount: amountUqor.toString() })));
export const parseExit = (p: Uint8Array): bigint | undefined =>
  has(p, EXIT_MAGIC) ? BigInt((JSON.parse(dec.decode(p.subarray(EXIT_MAGIC.length))) as { amount: string }).amount) : undefined;
