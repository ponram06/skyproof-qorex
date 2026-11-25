/**
 * Fly a demo delivery and post it to the rollup: the drone registration (once),
 * then each segment's sealed body and signed header.
 *
 * Usage: fly <scenario> [--drone SKY-002] [--withhold]
 *   --drone: which drone of the fleet (flight/fleet.ts) flies; default SKY-001
 *   scenarios: normal, people_below, link_lost, cheating, unapproved, shortcut, altitude, wind
 *   --withhold: the operator "loses" one segment body (a B5 breach)
 */
import { connect, txLine } from "../chain.js";
import { rdk, ROLLUP_ID } from "../config.js";
import { droneKey, kemKey, account } from "../keys.js";
import { GENESIS } from "../flight/record.js";
import { droneRegPost } from "../flight/posts.js";
import { FLEET } from "../flight/fleet.js";
import { simulate, SIM_SCENARIOS, type SimScenario } from "../sim/sim.js";
import { sealSegment } from "../flight/segment.js";
import { load, save } from "../state.js";
import { canonical, enc, hex, sha256 } from "../util.js";

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
  const di = process.argv.indexOf("--drone");
  const DRONE = di > 0 ? process.argv[di + 1] : "SKY-001";
  const unit = FLEET[DRONE];
  if (!unit) throw new Error(`drone must be one of: ${Object.keys(FLEET).join(", ")}`);

  const op = await connect("operator");
  const key = droneKey(DRONE);
  const st = load("operator", { droneRegistered: false, registered: [] as string[], flights: [] as FlightLog[] });
  st.registered ??= st.droneRegistered ? ["SKY-001"] : [];

  if (!st.registered.includes(DRONE)) {
    txLine(`drone ${DRONE} registered (${unit.area})`, await op.rdkTx.postRollupData({ rollupId: ROLLUP_ID, data: droneRegPost({ drone: DRONE, permit: unit.permit }, key.publicKey) }, { fee: "auto" }));
    st.registered.push(DRONE);
    st.droneRegistered = true;
    save("operator", st);
  }

  const recipients = await Promise.all(
    (["investigator", "insurer"] as const).map(async (role) => ({ member: (await account(role)).address, encapsulationKey: kemKey(role).publicKey })),
  );

  const flight = `${DRONE}-${scenario}-${Date.now()}`;
  const permitHash = hex(sha256(enc.encode(canonical(unit.permit))));
  const recs = simulate({ scenario, flight, drone: DRONE, permit: unit.permit, permitHash, seed: Date.now() % 100_000, world: unit.world });
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
