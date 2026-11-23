/** The demo permit: a delivery drone over a Mumbai block. Flights come from the simulator (../sim/sim.ts). */
import type { Permit } from "../rules.js";

export const DEMO_PERMIT: Permit = {
  area: { lat: 19.076, lon: 72.8777, r: 2000 },
  noFly: [{ lat: 19.09, lon: 72.8777, r: 300 }],
  maxAltM: 120,
  maxWindMs: 12,
  approvalTtlMs: 10_000,
  gated: ["TAKEOFF", "DROP", "LAND"],
};
