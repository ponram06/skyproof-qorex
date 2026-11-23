/** A victim reports harm from a flight. Usage: claim <flight id> [note] */
import { connect, txLine } from "../chain.js";
import { ROLLUP_ID } from "../config.js";
import { claimPost } from "../flight/posts.js";

async function main() {
  const flight = process.argv[2];
  if (!flight) throw new Error("usage: claim <flight id> [note]");
  const note = process.argv.slice(3).join(" ") || "Hit by a falling parcel near the drop point.";
  const victim = await connect("victim");
  txLine(`claim filed by ${victim.address}`, await victim.rdkTx.postRollupData({ rollupId: ROLLUP_ID, data: claimPost({ flight, note }) }, { fee: "auto" }));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
