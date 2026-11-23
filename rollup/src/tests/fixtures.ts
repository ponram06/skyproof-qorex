import { kemKeypairFromSeed } from "@qorechain/rdk";
import { generatePqcKeypair } from "@qorechain/sdk";
import type { FlightRecord } from "../flight/record.js";
import type { Permit } from "../rules.js";

export const ENV = { chainId: "qorechain-diana", rollupId: "skyproof-test" };

const seed = (n: number, len: number) => new Uint8Array(len).fill(n);

export const DRONE = { id: "SKY-001", ...generatePqcKeypair(seed(7, 32)) };
export const INVESTIGATOR = { address: "qor1investigator", kem: kemKeypairFromSeed(seed(1, 64)), seed: seed(1, 64) };
export const INSURER = { address: "qor1insurer", kem: kemKeypairFromSeed(seed(2, 64)), seed: seed(2, 64) };
export const STRANGER = { address: "qor1stranger", seed: seed(3, 64) };

export const RECIPIENTS = [
  { member: INVESTIGATOR.address, encapsulationKey: INVESTIGATOR.kem.publicKey },
  { member: INSURER.address, encapsulationKey: INSURER.kem.publicKey },
];

/** Deterministic randomness so tests are repeatable. */
export const fixedRandom = (n: number) => new Uint8Array(n).fill(9);

export const PERMIT: Permit = {
  area: { lat: 19.076, lon: 72.8777, r: 2000 },
  noFly: [{ lat: 19.09, lon: 72.8777, r: 300 }],
  maxAltM: 120,
  maxWindMs: 12,
  approvalTtlMs: 10_000,
  gated: ["TAKEOFF", "DROP", "LAND"],
};

/** A clean delivery flight. */
export function cleanFlight(): FlightRecord[] {
  const t0 = 1_795_000_000_000;
  const r: FlightRecord[] = [
    { seq: 0, t: t0, k: "OPEN", flight: "F1", drone: DRONE.id, permit: "permit-hash" },
    { seq: 1, t: t0 + 1000, k: "SAMPLE", lat: 19.076, lon: 72.8777, alt: 0, wind: 4 },
    { seq: 2, t: t0 + 2000, k: "DECISION", req: "r1", act: "TAKEOFF", ok: true },
    { seq: 3, t: t0 + 3000, k: "ACTION", req: "r1", act: "TAKEOFF" },
  ];
  for (let i = 0; i < 10; i++) r.push({ seq: r.length, t: t0 + 4000 + i * 1000, k: "SAMPLE", lat: 19.076 + i * 0.0005, lon: 72.8777, alt: 60, wind: 5 });
  r.push({ seq: r.length, t: t0 + 15_000, k: "DECISION", req: "r2", act: "DROP", ok: true });
  r.push({ seq: r.length, t: t0 + 16_000, k: "ACTION", req: "r2", act: "DROP" });
  r.push({ seq: r.length, t: t0 + 17_000, k: "DECISION", req: "r3", act: "LAND", ok: true });
  r.push({ seq: r.length, t: t0 + 18_000, k: "ACTION", req: "r3", act: "LAND" });
  r.push({ seq: r.length, t: t0 + 19_000, k: "CLOSE" });
  return r;
}
