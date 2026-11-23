/**
 * Execute every withdrawal of every finalized batch on QoreChain
 * (MsgExecuteWithdrawal with the Merkle path). Anyone may do this; here the
 * victim's account pays the fee. Usage: withdraw
 */
import { qledgerWithdrawalProof } from "@qorechain/rdk";
import { connect, txLine } from "../chain.js";
import { rdk, ROLLUP_ID, toQor } from "../config.js";
import { load, save } from "../state.js";

interface SubmitterState {
  batches: { index: number; withdrawals: { index: string; recipient: string; amount: string }[] }[];
}

async function main() {
  const st = load<SubmitterState>("submitter", { batches: [] });
  const done = load<Record<string, string>>("withdrawals", {});
  const who = await connect("victim");

  for (const b of st.batches.filter((x) => x.withdrawals.length > 0)) {
    const view = await rdk.rest.getBatch(ROLLUP_ID, b.index);
    if (view.status !== "finalized") {
      console.log(`batch ${b.index}: ${view.status}, ${b.withdrawals.length} withdrawal(s) wait for finalisation`);
      continue;
    }
    const ws = b.withdrawals.map((w) => ({ index: BigInt(w.index), recipient: w.recipient, amount: BigInt(w.amount) }));
    for (let i = 0; i < ws.length; i++) {
      const w = ws[i];
      if (done[w.index.toString()]) continue;
      const proof = qledgerWithdrawalProof(rdk.network.chainId, ROLLUP_ID, ws, i);
      const r = await who.rdkTx.executeWithdrawal(
        { rollupId: ROLLUP_ID, batchIndex: b.index, withdrawalIndex: w.index, recipient: w.recipient, denom: "uqor", amount: w.amount, proof },
        { fee: "auto" },
      );
      done[w.index.toString()] = txLine(`withdrawal ${w.index}: ${toQor(w.amount)} QOR to ${w.recipient}`, r);
      save("withdrawals", done);
    }
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
