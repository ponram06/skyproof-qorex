/**
 * The other SkyProof posts in the rollup inbox (besides segment BODY/HEADER):
 *
 *   DRONE  "SKYD1" | json {drone, permit}  | u32 len | ML-DSA-87 public key
 *          The operator registers a drone and its permit. Only a post by the
 *          rollup's creator counts.
 *   CLAIM  "SKYC1" | json {flight, victim, note}
 *          A victim reports harm from a flight. The poster address is the payee.
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

export interface Claim {
  flight: string;
  note: string;
}
export const claimPost = (c: Claim) => concat(CLAIM_MAGIC, enc.encode(JSON.stringify(c)));
export const parseClaim = (p: Uint8Array): Claim | undefined =>
  has(p, CLAIM_MAGIC) ? (JSON.parse(dec.decode(p.subarray(CLAIM_MAGIC.length))) as Claim) : undefined;

export const exitPost = (amountUqor: bigint) => concat(EXIT_MAGIC, enc.encode(JSON.stringify({ amount: amountUqor.toString() })));
export const parseExit = (p: Uint8Array): bigint | undefined =>
  has(p, EXIT_MAGIC) ? BigInt((JSON.parse(dec.decode(p.subarray(EXIT_MAGIC.length))) as { amount: string }).amount) : undefined;
