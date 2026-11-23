/**
 * Fly a demo delivery and post it to the rollup: the drone registration (once),
 * then each segment's sealed body and signed header.
 *
 * Usage: fly <scenario> [--withhold]
 *   scenarios: normal, people_below, link_lost, cheating, unapproved, shortcut, altitude, wind
 *   --withhold: the operator "loses" one segment body (a B5 breach)
 */
import { connect, txLine } from "../chain.js";
import { rdk, ROLLUP_ID } from "../config.js";
import { droneKey, kemKey, account } from "../keys.js";
import { GENESIS } from "../flight/record.js";
import { droneRegPost } from "../flight/posts.js";
import { DEMO_PERMIT } from "../flight/scenarios.js";
import { simulate, SIM_SCENARIOS, type SimScenario } from "../sim/sim.js";
import { sealSegment } from "../flight/segment.js";
import { load, save } from "../state.js";
import { canonical, enc, hex, sha256 } from "../util.js";

const DRONE = "SKY-001";
const PER_SEGMENT = 12;

export interface FlightLog {
  flight: string;
  scenario: string;
  withheld: number[];
  segments: { idx: number; body: string; head: string; bodyTx?: string; headerTx: string }[];
}

async function main() {
  const scenario = process.argv[2] as SimScenario;
  if (!SIM_SCENARIOS.includes(scenario)) throw new Error(`scenario must be one of: ${SIM_SCENARIOS.join(", ")}`);
  const withhold = process.argv.includes("--withhold");

  const op = await connect("operator");
  const key = droneKey(DRONE);
  const st = load("operator", { droneRegistered: false, flights: [] as FlightLog[] });

  if (!st.droneRegistered) {
    txLine(`drone ${DRONE} registered`, await op.rdkTx.postRollupData({ rollupId: ROLLUP_ID, data: droneRegPost({ drone: DRONE, permit: DEMO_PERMIT }, key.publicKey) }, { fee: "auto" }));
    st.droneRegistered = true;
    save("operator", st);
  }

  const recipients = await Promise.all(
    (["investigator", "insurer"] as const).map(async (role) => ({ member: (await account(role)).address, encapsulationKey: kemKey(role).publicKey })),
  );

  const flight = `${DRONE}-${scenario}-${Date.now()}`;
  const permitHash = hex(sha256(enc.encode(canonical(DEMO_PERMIT))));
  const recs = simulate({ scenario, flight, drone: DRONE, permit: DEMO_PERMIT, permitHash, seed: Date.now() % 100_000 });
  console.log(`flight ${flight}: ${recs.length} records`);

  const log: FlightLog = { flight, scenario, withheld: [], segments: [] };
  let prev = hex(GENESIS);
  for (let i = 0, idx = 0; i < recs.length; i += PER_SEGMENT, idx++) {
    const seg = sealSegment({ chainId: rdk.network.chainId, rollupId: ROLLUP_ID, recipients }, { id: DRONE, secretKey: key.secretKey }, { flight, idx, prev, recs: recs.slice(i, i + PER_SEGMENT) });
    const skip = withhold && idx === 1;
    const bodyTx = skip ? undefined : txLine(`segment ${idx} body (${seg.bodyPost.length} B, sealed)`, await op.rdkTx.postRollupData({ rollupId: ROLLUP_ID, data: seg.bodyPost }, { fee: "auto" }));
    if (skip) {
      console.log(`  segment ${idx} body: WITHHELD`);
      log.withheld.push(idx);
    }
    const headerTx = txLine(`segment ${idx} header (${seg.headerPost.length} B, signed)`, await op.rdkTx.postRollupData({ rollupId: ROLLUP_ID, data: seg.headerPost }, { fee: "auto" }));
    log.segments.push({ idx, body: seg.header.body, head: seg.header.head, bodyTx, headerTx });
    prev = seg.header.head;
  }
  st.flights.push(log);
  save("operator", st);
  console.log(`\nposted. File a claim with: npm run claim -- ${flight}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
