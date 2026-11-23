/**
 * Fraud demo: a second, dishonest submitter tries to steal the claims pool.
 *
 * The rogue bonds as a submitter and settles the next batch honestly except
 * for one thing: its withdrawals root pays the whole pool to itself. The
 * watchtower (npm run watch) re-executes the batch, sees the wrong root and
 * challenges it with a qledger fraud proof; the chain re-checks the proof and
 * slashes the rogue's bond.
 *
 * Usage: fraud-demo prepare   fund + bond the rogue, top up the judge's challenge bond
 *        fraud-demo submit    post one entry and submit the dishonest batch
 *        (npm run watch)      the watchtower challenges it with a fraud proof
 *        fraud-demo resolve <batch>   settle the challenge (any account may)
 */
import { ensurePqcRegistered } from "@qorechain/sdk";
import { planQledgerBatch, QLEDGER_WITHDRAWAL_COUNTER_ID, qledgerWithdrawalsRoot } from "@qorechain/rdk";
import { connect, txLine } from "../chain.js";
import { rdk, ROLLUP_ID, toQor } from "../config.js";
import { droneRegPost } from "../flight/posts.js";
import { DEMO_PERMIT } from "../flight/scenarios.js";
import { droneKey, poolKey } from "../keys.js";
import { checkBatch } from "../ledger.js";
import { load, loadLedger, type SavedAccount } from "../state.js";
import { unhex } from "../util.js";

const BOND = 1_000_000_000n; // 1,000 QOR: min submitter bond and the challenge bond
const FEES = 3_000_000n;

async function topUp(op: Awaited<ReturnType<typeof connect>>, to: string, want: bigint, label: string) {
  const bal = BigInt(await rdk.rest.getBalance(to));
  if (bal >= want) return console.log(`  ${label} already has ${toQor(bal)} QOR`);
  txLine(`${label} topped up by ${toQor(want - bal)} QOR`, await op.tx.bankSend(to, [{ denom: "uqor", amount: (want - bal).toString() }], { fee: "auto" }));
}

async function prepare() {
  const op = await connect("operator");
  const rogue = await connect("rogue");
  const judge = await connect("judge");
  console.log(`rogue ${rogue.address}\njudge ${judge.address}`);
  await topUp(op, rogue.address, BOND + FEES, "rogue");
  await topUp(op, judge.address, BOND + FEES, "judge (challenge bond)");
  if (!rogue.pqcRegistered) {
    const r = await ensurePqcRegistered(rogue.tx, { pqcKeypair: rogue.pqcKeypair, rest: rdk.network.endpoints.rest });
    console.log(`  rogue ML-DSA-87 key registered: ${r.txHash ?? "already"}`);
  }
  const r2 = await connect("rogue");
  const bond = await rdk.rest.getSubmitterBond(ROLLUP_ID, r2.address).catch(() => undefined);
  if (!bond || BigInt(bond.amount) < BOND) txLine("rogue bonded as submitter", await r2.rdkTx.bondRollupSubmitter({ rollupId: ROLLUP_ID, amount: BOND }, { fee: "auto" }));
  else console.log(`  rogue bond: ${toQor(bond.amount)} QOR`);
}

async function submit() {
  const env = { chainId: rdk.network.chainId, rollupId: ROLLUP_ID };
  const op = await connect("operator");
  const rogue = await connect("rogue");

  // The rollup's state after the last batch, as the watchtower re-executed it.
  const tower = load<{ ledger: SavedAccount[]; accFrom: string; next: number }>("watchtower", { ledger: [], accFrom: "", next: 0 });
  const latest = (await rdk.rest.getLatestBatch(ROLLUP_ID)).batchIndex;
  if (tower.next !== latest + 1) throw new Error(`run the watchtower first (it has seen ${tower.next} of ${latest + 1} batches)`);
  const inbox = await rdk.rest.getInbox(ROLLUP_ID);
  if (inbox.headSequence === inbox.consumedSequence) {
    // A batch must consume at least one post: repost the drone registration (the watchtower ignores duplicates).
    txLine("a post for the batch to consume", await op.rdkTx.postRollupData({ rollupId: ROLLUP_ID, data: droneRegPost({ drone: "SKY-001", permit: DEMO_PERMIT }, droneKey("SKY-001").publicKey) }, { fee: "auto" }));
    console.log("wait ~20 blocks (the chain only admits posts at least 20 blocks old), then run submit again");
    return;
  }

  const parent = loadLedger(tower.ledger);
  const plan = await planQledgerBatch(rdk.rest, { ...env, submitter: rogue.address, ledger: parent });
  const pool = poolKey();
  const stolen = plan.ledger.get(pool.accountId).balance;
  const nextIndex = plan.ledger.get(QLEDGER_WITHDRAWAL_COUNTER_ID).balance; // the rollup's next global withdrawal index
  // The lie: the batch's withdrawals root pays the whole pool to the rogue.
  const fake = [...plan.result.withdrawals, { index: nextIndex, recipient: rogue.address, amount: stolen }];
  const lie = { ...plan.input, withdrawalsRoot: qledgerWithdrawalsRoot(env.chainId, ROLLUP_ID, fake) };

  // Before broadcasting, make sure the watchtower's check really catches it.
  const check = checkBatch(env, parent, unhex(tower.accFrom), plan.entries, {
    inboxStart: BigInt(inbox.consumedSequence),
    inboxEnd: lie.inboxEnd,
    dataHash: lie.dataHash,
    prevStateRoot: lie.prevStateRoot,
    stateRoot: lie.stateRoot,
    withdrawalsRoot: lie.withdrawalsRoot,
  });
  if (check.valid) throw new Error("the lie would not be caught: not submitting");
  console.log(`dishonest batch ${lie.batchIndex}: claims ${toQor(stolen)} QOR for the rogue (watchtower will see: ${check.reason})`);
  txLine("rogue submitted the batch (unanchored: not the creator)", await rogue.rdkTx.submitBatch(lie, { fee: "auto", anchor: "off" }));
  console.log("now run the watchtower: npm run watch");
}

async function resolve() {
  const index = Number(process.argv[3]);
  if (!Number.isInteger(index)) throw new Error("usage: fraud-demo resolve <batch>");
  const judge = await connect("judge");
  txLine(`challenge on batch ${index} resolved (fraud upheld)`, await judge.rdkTx.resolveChallenge({ rollupId: ROLLUP_ID, batchIndex: index, fraudUpheld: true }, { fee: "auto" }));
  const b = await rdk.rest.getBatch(ROLLUP_ID, index);
  console.log(`batch ${index} is now: ${b.status}`);
}

const cmd = process.argv[2];
(cmd === "prepare" ? prepare() : cmd === "submit" ? submit() : cmd === "resolve" ? resolve() : Promise.reject(new Error("usage: fraud-demo prepare|submit|resolve <batch>"))).catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
