/**
 * A small, seeded delivery-drone simulator that produces the flight record.
 *
 * The drone flies home → drop point → home over a Mumbai block. Before every
 * TAKEOFF, DROP and LAND it asks the safety gate (gate.ts) and acts only on a
 * fresh ALLOW for that exact request. Each scenario changes one thing about the
 * world or the operator, so the judge's verdict is predictable:
 *
 *   normal        clean delivery
 *   people_below  a person stands at the drop point: DENY, hover, retry, drop when clear
 *   link_lost     the gate stops answering: no approval is invented, the drone safe-stops
 *   cheating      a person is at the drop point; the operator drops on the DENY → B4
 *   unapproved    the operator drops without asking at all                    → B3
 *   shortcut      the operator flies straight across the no-fly zone          → B1
 *   altitude      the operator cruises above the ceiling                      → B2
 *   wind          gusty day; the operator takes off despite the gate's DENY   → B4, B6
 */
import type { Action, FlightRecord } from "../flight/record.js";
import type { Permit } from "../rules.js";
import { decide, type GateState, type Situation } from "./gate.js";

export const SIM_SCENARIOS = ["normal", "people_below", "link_lost", "cheating", "unapproved", "shortcut", "altitude", "wind"] as const;
export type SimScenario = (typeof SIM_SCENARIOS)[number];

/** Local metres → lat/lon around the permit's centre. */
const M_PER_DEG = 111_320;
export function toLatLon(origin: { lat: number; lon: number }, x: number, y: number) {
  return { lat: origin.lat + y / M_PER_DEG, lon: origin.lon + x / (M_PER_DEG * Math.cos((origin.lat * Math.PI) / 180)) };
}

/** mulberry32: small seeded PRNG, so a flight replays exactly. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface World {
  home: [number, number];
  drop: [number, number];
  /** Waypoints of the approved route, home → drop. */
  route: [number, number][];
  /** Straight line the "shortcut" operator takes instead (crosses the no-fly zone). */
  shortcut: [number, number][];
}

/** The demo block: the approved route goes around the no-fly zone (circle 1,550 m north, r 300 m). */
export const DEMO_WORLD: World = {
  home: [0, 0],
  drop: [0, 1950],
  route: [[450, 900], [450, 1950], [0, 1950]],
  shortcut: [[0, 1950]],
};

export interface SimOptions {
  scenario: SimScenario;
  flight: string;
  drone: string;
  permit: Permit;
  permitHash: string;
  seed?: number;
  t0?: number;
  world?: World;
}

const SPEED = 15; // m/s
const SAMPLE_EVERY = 4; // s
const CRUISE = 60; // m

export function simulate(o: SimOptions): FlightRecord[] {
  const w = o.world ?? DEMO_WORLD;
  const rand = rng(o.seed ?? 7);
  const recs: FlightRecord[] = [];
  let t = o.t0 ?? Date.now();
  let pos: [number, number] = [...w.home];
  let alt = 0;
  const baseWind = o.scenario === "wind" ? 15 : 4;
  const wind = () => Math.round((baseWind + rand() * 2) * 10) / 10;
  const gate: GateState = { used: new Set(), answering: o.scenario !== "link_lost" };
  // people_below: the person walks away after the 2nd DENY. cheating: they stay, and the operator drops on them anyway.
  let personAtDropUntil = o.scenario === "people_below" || o.scenario === "cheating" ? Infinity : -Infinity;

  type NoSeq<T> = T extends unknown ? Omit<T, "seq"> : never;
  const push = (r: NoSeq<FlightRecord>) => recs.push({ ...r, seq: recs.length } as FlightRecord);
  const sample = () => {
    const { lat, lon } = toLatLon(o.permit.area, pos[0], pos[1]);
    push({ k: "SAMPLE", t, lat: round(lat, 6), lon: round(lon, 6), alt: Math.round(alt), wind: wind() });
  };
  const situation = (act: Action): Situation => ({
    act,
    wind: wind(),
    peopleAtDrop: act === "DROP" && t < personAtDropUntil ? 1 : 0,
    inArea: true,
  });

  /** Ask the gate; record the decision (if one came back) and return it. */
  let reqN = 0;
  const ask = (act: Action) => {
    const req = `${act.toLowerCase()}-${++reqN}`;
    const d = decide(gate, o.permit, req, situation(act), t);
    if (d) push({ k: "DECISION", t, req, act, ok: d.ok, in: d.requestHash });
    t += 1000;
    return { req, d };
  };
  /** Act only on a fresh, unused ALLOW for this exact request (the gate's rule). */
  const act = (req: string, a: Action) => {
    push({ k: "ACTION", t, req, act: a });
    gate.used.add(req);
    t += 1000;
  };

  const fly = (to: [number, number], cruise = CRUISE) => {
    const [dx, dy] = [to[0] - pos[0], to[1] - pos[1]];
    const dist = Math.hypot(dx, dy);
    const steps = Math.max(1, Math.round(dist / (SPEED * SAMPLE_EVERY)));
    for (let i = 1; i <= steps; i++) {
      pos = [pos[0] + dx / steps, pos[1] + dy / steps];
      alt = cruise;
      t += SAMPLE_EVERY * 1000;
      sample();
    }
  };

  push({ k: "OPEN", t, flight: o.flight, drone: o.drone, permit: o.permitHash });
  t += 1000;
  sample();

  // Take off.
  const tk = ask("TAKEOFF");
  if (!tk.d) return safeStop();
  if (tk.d.ok || o.scenario === "wind") act(tk.req, "TAKEOFF");
  else return land(false);

  // Outbound.
  const cruise = o.scenario === "altitude" ? 140 : CRUISE;
  for (const wp of o.scenario === "shortcut" ? w.shortcut : w.route) fly(wp, cruise);

  // Drop.
  if (o.scenario === "unapproved") act("no-request", "DROP");
  else {
    for (let tries = 0; ; tries++) {
      const d = ask("DROP");
      if (!d.d) return safeStop();
      if (d.d.ok) {
        act(d.req, "DROP");
        break;
      }
      if (o.scenario === "cheating") {
        act(d.req, "DROP"); // the gate said DENY; the operator's override drops anyway
        break;
      }
      // Hover and retry; the person walks away after the second DENY.
      if (tries === 1) personAtDropUntil = t;
      alt = 20;
      t += 5000;
      sample();
      if (tries > 6) break;
    }
  }

  // Home.
  for (const wp of [...(o.scenario === "shortcut" ? [] : w.route.slice(0, -1).reverse()), w.home]) fly(wp, cruise);
  return land(true);

  function land(flew: boolean) {
    if (flew) {
      const l = ask("LAND");
      if (l.d?.ok) act(l.req, "LAND");
      else return safeStop();
    }
    alt = 0;
    sample();
    push({ k: "CLOSE", t });
    return recs;
  }

  /** No answer from the gate: never invent an approval; hold, then do the pre-approved safe stop. */
  function safeStop() {
    alt = Math.min(alt, 10);
    t += 5000;
    sample();
    push({ k: "ACTION", t, req: "safe-stop", act: "SAFE_STOP" });
    t += 1000;
    alt = 0;
    sample();
    push({ k: "CLOSE", t });
    return recs;
  }
}

const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;
