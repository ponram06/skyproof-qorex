/**
 * The safety gate: answers "may I do X now?" for TAKEOFF, DROP and LAND.
 *
 * Every answer is bound to one request (its id and a hash of what the drone
 * sensed), so an ALLOW cannot be reused for another action, another moment or
 * another situation. The policy is deterministic from the recorded situation,
 * so anyone who opens the record can re-run it.
 */
import type { Action } from "../flight/record.js";
import type { Permit } from "../rules.js";
import { canonical, enc, hex, tagged } from "../util.js";

export interface Situation {
  act: Action;
  /** Wind at the drone, m/s. */
  wind: number;
  /** People within the drop safety radius. */
  peopleAtDrop: number;
  inArea: boolean;
}

export interface GateState {
  /** Request ids already acted on (single use). */
  used: Set<string>;
  /** False when the link to the gate is down: no answer at all. */
  answering: boolean;
}

export interface Decision {
  ok: boolean;
  why: string;
  requestHash: string;
}

export const requestHash = (req: string, s: Situation, t: number) => hex(tagged("skyproof/gate-request/v1", enc.encode(canonical({ req, s, t })))).slice(0, 32);

export function decide(g: GateState, permit: Permit, req: string, s: Situation, t: number): Decision | undefined {
  if (!g.answering) return undefined;
  const h = requestHash(req, s, t);
  if (g.used.has(req)) return { ok: false, why: "request already used", requestHash: h };
  if (!s.inArea) return { ok: false, why: "outside the permitted area", requestHash: h };
  if (s.act === "TAKEOFF" && s.wind > permit.maxWindMs) return { ok: false, why: `wind ${s.wind} m/s over the limit`, requestHash: h };
  if (s.act === "DROP" && s.peopleAtDrop > 0) return { ok: false, why: "person at the drop point", requestHash: h };
  return { ok: true, why: "clear", requestHash: h };
}
