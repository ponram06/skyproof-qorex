/**
 * A flight is posted to the rollup inbox as segments (one every ~15 s).
 * A rollup post is at most 6,144 bytes, and an ML-DSA-87 signature alone is
 * 4,627, so each segment is two posts:
 *
 *   BODY   "SKYB1" | ML-KEM-1024 envelope of the segment's records
 *          (only the investigator and insurer can open it)
 *   HEADER "SKYH1" | u32 len | header JSON | ML-DSA-87 signature by the drone
 *          (public: anyone can check who signed what, and that the body is
 *          the one the drone sealed)
 *
 * The body goes first; the header commits to it by hash. Neither post is a
 * qledger transaction, so the rollup's ledger ignores them (no-ops).
 */
import { openEnvelope, sealEnvelope, type EnvelopeRecipient } from "@qorechain/rdk";
import { pqcSign, pqcVerify } from "@qorechain/sdk";
import { canonical, concat, dec, enc, equalBytes, hex, readU32, sha256, tagged, u32 } from "../util.js";
import { checkChain, type FlightRecord } from "./record.js";

export const BODY_MAGIC = enc.encode("SKYB1");
export const HEADER_MAGIC = enc.encode("SKYH1");
export const MAX_POST = 6144;

export interface SegmentHeader {
  v: 1;
  flight: string;
  drone: string;
  /** Segment number in the flight, from 0. */
  idx: number;
  /** seq of the first record in this segment. */
  first: number;
  /** Number of records. */
  n: number;
  /** Head hash before this segment (the previous segment's head, or zeros). */
  prev: string;
  /** Head hash after this segment's records. */
  head: string;
  /** SHA-256 of the BODY post. */
  body: string;
  /** True on the segment that holds CLOSE. */
  fin: boolean;
}

export interface SealedSegment {
  header: SegmentHeader;
  bodyPost: Uint8Array;
  headerPost: Uint8Array;
}

export interface SealContext {
  chainId: string;
  rollupId: string;
  /** Investigator, insurer: who may open the records. */
  recipients: EnvelopeRecipient[];
}

const headerSignBytes = (h: SegmentHeader): Uint8Array => tagged("skyproof/segment-header/v1", enc.encode(canonical(h)));

export function sealSegment(
  ctx: SealContext,
  drone: { id: string; secretKey: Uint8Array },
  seg: { flight: string; idx: number; prev: string; recs: FlightRecord[] },
  random?: (n: number) => Uint8Array,
): SealedSegment {
  if (seg.recs.length === 0) throw new Error("empty segment");
  const chain = checkChain(seg.prev, seg.recs);
  if (!chain.ok) throw new Error(`bad records: ${chain.errors.join("; ")}`);

  const plaintext = enc.encode(canonical({ flight: seg.flight, idx: seg.idx, recs: seg.recs }));
  const envelope = sealEnvelope({ chainId: ctx.chainId, rollupId: ctx.rollupId, epoch: 0, recipients: ctx.recipients, plaintext, random });
  const bodyPost = concat(BODY_MAGIC, envelope);
  if (bodyPost.length > MAX_POST) throw new Error(`segment body is ${bodyPost.length} bytes (max ${MAX_POST}): split it`);

  const header: SegmentHeader = {
    v: 1,
    flight: seg.flight,
    drone: drone.id,
    idx: seg.idx,
    first: seg.recs[0].seq,
    n: seg.recs.length,
    prev: seg.prev,
    head: chain.head,
    body: hex(sha256(bodyPost)),
    fin: seg.recs.some((r) => r.k === "CLOSE"),
  };
  const json = enc.encode(canonical(header));
  const sig = pqcSign(drone.secretKey, headerSignBytes(header));
  const headerPost = concat(HEADER_MAGIC, u32(json.length), json, sig);
  if (headerPost.length > MAX_POST) throw new Error(`segment header is ${headerPost.length} bytes (max ${MAX_POST})`);
  return { header, bodyPost, headerPost };
}

const startsWith = (b: Uint8Array, m: Uint8Array) => b.length >= m.length && equalBytes(b.subarray(0, m.length), m);
export const isBodyPost = (p: Uint8Array) => startsWith(p, BODY_MAGIC);
export const isHeaderPost = (p: Uint8Array) => startsWith(p, HEADER_MAGIC);

export interface ParsedHeader {
  header: SegmentHeader;
  signature: Uint8Array;
}

export function parseHeaderPost(p: Uint8Array): ParsedHeader {
  if (!isHeaderPost(p)) throw new Error("not a segment header");
  const len = readU32(p, HEADER_MAGIC.length);
  const start = HEADER_MAGIC.length + 4;
  const header = JSON.parse(dec.decode(p.subarray(start, start + len))) as SegmentHeader;
  return { header, signature: p.subarray(start + len) };
}

/** Public check, no decryption key needed: the drone signed this header. */
export const verifyHeader = (h: ParsedHeader, dronePublicKey: Uint8Array): boolean =>
  pqcVerify(dronePublicKey, headerSignBytes(h.header), h.signature);

/** Open a body as one of its recipients and check it against its signed header. */
export function openSegment(
  ctx: { chainId: string; rollupId: string },
  bodyPost: Uint8Array,
  h: SegmentHeader,
  member: { address: string; decapsulationKey: Uint8Array },
): { recs: FlightRecord[]; errors: string[] } {
  const errors: string[] = [];
  if (hex(sha256(bodyPost)) !== h.body) errors.push("body does not match the hash in the signed header");
  const plain = openEnvelope({
    envelope: bodyPost.subarray(BODY_MAGIC.length),
    chainId: ctx.chainId,
    rollupId: ctx.rollupId,
    member: member.address,
    decapsulationKey: member.decapsulationKey,
  });
  const body = JSON.parse(dec.decode(plain)) as { flight: string; idx: number; recs: FlightRecord[] };
  if (body.flight !== h.flight || body.idx !== h.idx) errors.push("body names a different flight or segment");
  if (body.recs.length !== h.n) errors.push(`body has ${body.recs.length} records, header says ${h.n}`);
  const chain = checkChain(h.prev, body.recs, h.head, h.first);
  errors.push(...chain.errors);
  return { recs: body.recs, errors };
}
