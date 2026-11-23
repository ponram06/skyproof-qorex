/**
 * Settle the next batch: execute the waiting inbox posts with qledger-v1 and
 * submit the roots. As the rollup's creator signing hybrid, the client adds the
 * ML-DSA-87 anchor signature, so the batch is anchored in the same tx.
 */
import { planQledgerBatch } from "@qorechain/rdk";
import { connect, txLine } from "../chain.js";
import { rdk, ROLLUP_ID } from "../config.js";
import { load, loadLedger, save, saveLedger, type SavedAccount } from "../state.js";
import { hex } from "../util.js";

interface SubmitterState {
  ledger: SavedAccount[];
  batches: { index: number; inboxEnd: number; stateRoot: string; withdrawals: { index: string; recipient: string; amount: string }[]; tx: string }[];
}

async function main() {
  const op = await connect("operator");
  const st = load<SubmitterState>("submitter", { ledger: [], batches: [] });
  const plan = await planQledgerBatch(rdk.rest, { chainId: rdk.network.chainId, rollupId: ROLLUP_ID, submitter: op.address, ledger: loadLedger(st.ledger) });

  console.log(`batch ${plan.input.batchIndex}: ${plan.entries.length} inbox entries, ${plan.result.withdrawals.length} withdrawal(s)`);
  const tx = txLine("submitted (anchored, ML-DSA-87)", await op.rdkTx.submitBatch(plan.input, { fee: "auto", anchor: "require" }));

  st.ledger = saveLedger(plan.ledger);
  st.batches.push({
    index: Number(plan.input.batchIndex),
    inboxEnd: Number(plan.input.inboxEnd),
    stateRoot: hex(plan.result.stateRoot),
    withdrawals: plan.result.withdrawals.map((w) => ({ index: w.index.toString(), recipient: w.recipient, amount: w.amount.toString() })),
    tx,
  });
  save("submitter", st);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
