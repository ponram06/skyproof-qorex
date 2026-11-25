/**
 * The demo fleet: each drone has its own permit (where it may fly) and the
 * delivery route it flies. A permit is public in the drone's registration, so
 * anyone can see which drones are allowed to fly over a given place; that is
 * how a victim who didn't see a drone's ID can still find it.
 */
import type { Permit } from "../rules.js";
import { DEMO_WORLD, type World } from "../sim/sim.js";
import { DEMO_PERMIT } from "./scenarios.js";

const permit = (lat: number, lon: number, noFly: Permit["noFly"]): Permit => ({ ...DEMO_PERMIT, area: { lat, lon, r: 2000 }, noFly });

export const FLEET: Record<string, { permit: Permit; world: World; area: string }> = {
  // Central Mumbai (Kurla/BKC). Its no-fly zone is 1.55 km north of home base.
  "SKY-001": { permit: DEMO_PERMIT, world: DEMO_WORLD, area: "Kurla, Mumbai" },
  // Bandra West. No-fly zone over the hospital 1 km south-east.
  "SKY-002": {
    permit: permit(19.0596, 72.8295, [{ lat: 19.0526, lon: 72.8375, r: 250 }]),
    world: { home: [0, 0], drop: [-900, 1100], route: [[-900, 0], [-900, 1100]], shortcut: [[-900, 1100]] },
    area: "Bandra West, Mumbai",
  },
  // Andheri East. No-fly zone over the airport approach 1.2 km west.
  "SKY-003": {
    permit: permit(19.1136, 72.8697, [{ lat: 19.1136, lon: 72.8583, r: 300 }]),
    world: { home: [0, 0], drop: [800, -1200], route: [[800, 0], [800, -1200]], shortcut: [[800, -1200]] },
    area: "Andheri East, Mumbai",
  },
};
