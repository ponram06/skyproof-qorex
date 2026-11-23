/**
 * Create SkyProof's rollup on qorechain-diana and bond the operator as its
 * batch submitter. Optimistic settlement with qledger-v1 execution and based
 * sequencing: the chain can re-execute any batch in a fraud proof.
 */
import { isRestNotFound } from "@qorechain/rdk";
import { connect, txLine } from "../chain.js";
import { rdk, ROLLUP_ID, toQor } from "../config.js";

async function main() {
  const op = await connect("operator");
  const p = await rdk.params();

  let exists = true;
  try {
    await rdk.rest.getRollup(ROLLUP_ID);
  } catch (e) {
    if (!isRestNotFound(e)) throw e;
    exists = false;
  }

  if (!exists) {
    console.log(`creating ${ROLLUP_ID}: stake ${toQor(p.minStakeForRollup)} QOR`);
    txLine(
      "rollup created",
      await op.rdkTx.createRollup(
        { rollupId: ROLLUP_ID, profile: "nft", vmType: "custom", stakeAmount: p.minStakeForRollup, sequencing: "based", executionVm: "qledger-v1" },
        { fee: "auto" },
      ),
    );
  } else console.log(`${ROLLUP_ID} already exists`);

  const bond = await rdk.rest.getSubmitterBond(ROLLUP_ID, op.address).catch(() => undefined);
  const minBond = BigInt(p.minSubmitterBond ?? "1000000000");
  if (!bond || BigInt(bond.amount) < minBond) {
    const add = minBond - BigInt(bond?.amount ?? 0);
    txLine(`submitter bond ${toQor(add)} QOR`, await op.rdkTx.bondRollupSubmitter({ rollupId: ROLLUP_ID, amount: add }, { fee: "auto" }));
  } else console.log(`submitter bond: ${toQor(bond.amount)} QOR`);

  const r = await rdk.rest.getRollup(ROLLUP_ID);
  console.log(`\n${r.rollupId}: ${r.status}, ${r.settlementMode}, ${r.executionVm}, sequencing ${r.sequencing}`);
  console.log(`  layer ${r.layerId || "(none: batches cannot be anchored!)"}, challenge window ${r.challengeWindowSec ?? "?"}s`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
