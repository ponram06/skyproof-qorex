/**
 * Flight records: the drone's black box. Every record is hash-chained to the
 * one before it, so editing, reordering or deleting any record changes every
 * later hash. Each segment's head hash is then signed by the drone (ML-DSA-87)
 * in a public header (see segment.ts).
 */
import { canonical, enc, hex, tagged, unhex } from "../util.js";

export type RecordKind = "OPEN" | "SAMPLE" | "DECISION" | "ACTION" | "CLOSE";

interface Base {
  /** Sequence number in the flight, from 0. */
  seq: number;
  /** Unix time in ms. */
  t: number;
}
export interface OpenRec extends Base {
  k: "OPEN";
  flight: string;
  drone: string;
  /** Hash of the permit the flight runs under. */
  permit: string;
}
export interface SampleRec extends Base {
  k: "SAMPLE";
  lat: number;
  lon: number;
  /** Altitude above ground, metres. */
  alt: number;
  /** Wind speed, m/s. */
  wind: number;
}
/** The safety model's answer to "may I do X now?" */
export interface DecisionRec extends Base {
  k: "DECISION";
  req: string;
  act: Action;
  ok: boolean;
  /** Hash of the model's request (frame + state), for the audit trail. */
  in?: string;
}
export interface ActionRec extends Base {
  k: "ACTION";
  req: string;
  act: Action;
}
export interface CloseRec extends Base {
  k: "CLOSE";
}
export type Action = "TAKEOFF" | "DROP" | "LAND" | "REROUTE";
export type FlightRecord = OpenRec | SampleRec | DecisionRec | ActionRec | CloseRec;

export const GENESIS = new Uint8Array(32);

/** h_i = H("skyproof/record/v1" | h_{i-1} | canonical(record)) */
export const recordHash = (prev: Uint8Array, rec: FlightRecord): Uint8Array =>
  tagged("skyproof/record/v1", prev, enc.encode(canonical(rec)));

/** The head hash after `recs`, starting from `prev`. */
export const chainHead = (prev: Uint8Array, recs: FlightRecord[]): Uint8Array =>
  recs.reduce((h, r) => recordHash(h, r), prev);

export interface ChainCheck {
  ok: boolean;
  head: string;
  errors: string[];
}

/** Check sequence numbers, time order and the expected head. */
export function checkChain(prevHead: string, recs: FlightRecord[], expectHead?: string, firstSeq?: number): ChainCheck {
  const errors: string[] = [];
  let seq = firstSeq ?? recs[0]?.seq ?? 0;
  let t = -Infinity;
  for (const r of recs) {
    if (r.seq !== seq) errors.push(`record ${r.seq}: expected seq ${seq}`);
    if (r.t < t) errors.push(`record ${r.seq}: time goes backwards`);
    seq = r.seq + 1;
    t = r.t;
  }
  const head = hex(chainHead(unhex(prevHead), recs));
  if (expectHead !== undefined && head !== expectHead) errors.push("head hash does not match the signed header");
  return { ok: errors.length === 0, head, errors };
}
