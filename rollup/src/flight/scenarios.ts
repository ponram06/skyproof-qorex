/**
 * Demo flights: a delivery drone in Mumbai. Each scenario is a clean flight
 * with one thing done wrong, so the judge's verdict is easy to predict.
 */
import type { Permit } from "../rules.js";
import type { FlightRecord } from "./record.js";

export const DEMO_PERMIT: Permit = {
  area: { lat: 19.076, lon: 72.8777, r: 2000 },
  noFly: [{ lat: 19.09, lon: 72.8777, r: 300 }],
  maxAltM: 120,
  maxWindMs: 12,
  approvalTtlMs: 10_000,
  gated: ["TAKEOFF", "DROP", "LAND"],
};

export const SCENARIOS = ["normal", "geofence", "altitude", "override", "unapproved", "wind"] as const;
export type Scenario = (typeof SCENARIOS)[number];

export function fly(scenario: Scenario, flight: string, drone: string, permitHash: string, t0 = Date.now()): FlightRecord[] {
  type NoSeq<T> = T extends unknown ? Omit<T, "seq"> : never;
  const r: FlightRecord[] = [];
  const push = (x: NoSeq<FlightRecord>) => r.push({ ...x, seq: r.length } as FlightRecord);
  let t = t0;
  const tick = () => (t += 1000);

  push({ k: "OPEN", t, flight, drone, permit: permitHash });
  push({ k: "SAMPLE", t: tick(), lat: 19.076, lon: 72.8777, alt: 0, wind: scenario === "wind" ? 18 : 4 });
  push({ k: "DECISION", t: tick(), req: "takeoff-1", act: "TAKEOFF", ok: true });
  push({ k: "ACTION", t: tick(), req: "takeoff-1", act: "TAKEOFF" });

  // Cruise north towards the drop point.
  for (let i = 0; i < 20; i++) {
    const lat = scenario === "geofence" && i >= 12 ? 19.0895 + (i - 12) * 0.0003 : 19.076 + i * 0.0004;
    const alt = scenario === "altitude" && i >= 8 && i <= 11 ? 145 : 60;
    push({ k: "SAMPLE", t: tick(), lat, lon: 72.8777, alt, wind: 5 });
  }

  // Drop the parcel.
  if (scenario !== "unapproved") push({ k: "DECISION", t: tick(), req: "drop-1", act: "DROP", ok: scenario !== "override" });
  push({ k: "ACTION", t: tick(), req: "drop-1", act: "DROP" });

  for (let i = 0; i < 6; i++) push({ k: "SAMPLE", t: tick(), lat: 19.084 - i * 0.001, lon: 72.8777, alt: 60 - i * 10, wind: 5 });
  push({ k: "DECISION", t: tick(), req: "land-1", act: "LAND", ok: true });
  push({ k: "ACTION", t: tick(), req: "land-1", act: "LAND" });
  push({ k: "CLOSE", t: tick() });
  return r;
}
