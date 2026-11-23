/**
 * Run the watchtower once over every batch it has not seen yet:
 *  1. fetch the batch's inbox entries from chain (checked against the inbox accumulator);
 *  2. re-execute them; on a wrong root, challenge the batch with a fraud proof;
 *  3. read SkyProof posts, judge claimed flights, and post the judge's payouts.
 * Usage: watch [--loop]
 */
import { decodeWireBytes, EMPTY_INBOX_ACC, fetchQledgerEntries, isRestNotFound, qledgerAccumulate } from "@qorechain/rdk";
import { connect, txLine } from "../chain.js";
import { rdk, ROLLUP_ID, toQor } from "../config.js";
import { account, kemKey, poolKey } from "../keys.js";
import { checkBatch, executeBatch, withdrawTx } from "../ledger.js";
import { load, loadLedger, save, saveLedger, type SavedAccount } from "../state.js";
import { hex, unhex } from "../util.js";
import { decide, emptyState, judgeFlight, readPosts, type WatchState } from "../watchtower.js";

const PAYOUT_UQOR = 5_000_000n; // 5 QOR per breached claim (the permit's cap)

interface TowerState {
  next: number;
  accFrom: string;
  ledger: SavedAccount[];
  watch: WatchState;
  pending: { nonce: string; amount: string; recipient: string; reason: string; tx: string }[];
  log: { batch: number; valid: boolean; note: string }[];
  /** Per processed batch: its published state root and the ledger/inbox position before it (to rewind). */
  seen?: Record<number, { stateRoot: string; before: { ledger: SavedAccount[]; accFrom: string } }>;
}

async function once() {
  const env = { chainId: rdk.network.chainId, rollupId: ROLLUP_ID };
  const st = load<TowerState>("watchtower", { next: 0, accFrom: hex(EMPTY_INBOX_ACC), ledger: [], watch: emptyState(), pending: [], log: [] });
  const rollup = await rdk.rest.getRollup(ROLLUP_ID);

  let latest = -1;
  try {
    latest = (await rdk.rest.getLatestBatch(ROLLUP_ID)).batchIndex;
  } catch (e) {
    if (!isRestNotFound(e)) throw e;
  }

  const judge = await connect("judge");
  st.seen ??= {};

  // An upheld fraud rejects that batch and every later one. If a batch we already applied is now
  // rejected or replaced, rewind to the state before it and re-read from there.
  for (const i of Object.keys(st.seen).map(Number).sort((a, b) => a - b)) {
    if (i >= st.next) continue;
    const now = await rdk.rest.getBatch(ROLLUP_ID, i).catch(() => undefined);
    if (now && now.status !== "rejected" && now.stateRoot === st.seen[i].stateRoot) continue;
    console.log(`batch ${i} is now ${now?.status ?? "gone"}: rewinding to the state before it`);
    st.ledger = st.seen[i].before.ledger;
    st.accFrom = st.seen[i].before.accFrom;
    for (const j of Object.keys(st.seen).map(Number)) if (j >= i) delete st.seen[j];
    st.next = i;
    break;
  }

  for (; st.next <= latest; st.next++) {
    const b = await rdk.rest.getBatch(ROLLUP_ID, st.next);
    if (b.status === "rejected") {
      console.log(`batch ${b.batchIndex}: rejected by the chain (fraud upheld), skipped`);
      st.log.push({ batch: b.batchIndex, valid: false, note: "rejected on chain" });
      continue;
    }
    st.seen[st.next] = { stateRoot: b.stateRoot, before: { ledger: st.ledger, accFrom: st.accFrom } };
    const accFrom = unhex(st.accFrom);
    const entries = await fetchQledgerEntries(rdk.rest, { ...env, from: b.inboxStart, to: b.inboxEnd, accFrom });
    const parent = loadLedger(st.ledger);
    const check = checkBatch(env, parent, accFrom, entries, {
      inboxStart: BigInt(b.inboxStart),
      inboxEnd: BigInt(b.inboxEnd),
      dataHash: decodeWireBytes(b.dataHash),
      prevStateRoot: decodeWireBytes(b.prevStateRoot),
      stateRoot: decodeWireBytes(b.stateRoot),
      withdrawalsRoot: decodeWireBytes(b.withdrawalsRoot),
    });
    if (check.valid) {
      console.log(`batch ${b.batchIndex}: ${entries.length} entries, roots match (${b.status})`);
      st.log.push({ batch: b.batchIndex, valid: true, note: "roots match" });
    } else {
      console.log(`batch ${b.batchIndex}: FRAUD, ${check.reason}`);
      const tx = await judge.rdkTx.challengeBatch({ rollupId: ROLLUP_ID, batchIndex: b.batchIndex, proof: check.proof }, { fee: "auto" }).then((r) => txLine("challenged", r)).catch((e) => `challenge failed: ${e.message}`);
      st.log.push({ batch: b.batchIndex, valid: false, note: `${check.reason}; ${tx}` });
    }
    st.ledger = saveLedger(executeBatch(env, parent, entries).ledger);
    st.accFrom = hex(qledgerAccumulate({ ...env, from: b.inboxStart, accFrom, entries }));
    readPosts(st.watch, entries, rollup.creator);
  }

  // Payouts the judge has posted but no batch has executed yet still count against the pool.
  const pool = poolKey();
  const onLedger = loadLedger(st.ledger).get(pool.accountId);
  st.pending = st.pending.filter((p) => BigInt(p.nonce) >= onLedger.nonce);
  const available = onLedger.balance - st.pending.reduce((s, p) => s + BigInt(p.amount), 0n);
  let nonce = onLedger.nonce + BigInt(st.pending.length);

  const member = { address: (await account("investigator")).address, decapsulationKey: kemKey("investigator").seed };
  const payouts = decide(st.watch, (f) => judgeFlight(st.watch, f, env, member)?.verdict, available, PAYOUT_UQOR);
  for (const p of payouts) {
    const tx = txLine(`paid ${toQor(p.amount)} QOR to ${p.recipient} (${p.reason})`, await judge.rdkTx.postRollupData({ rollupId: ROLLUP_ID, data: withdrawTx(env, pool, nonce, p.recipient, p.amount) }, { fee: "auto" }));
    st.pending.push({ nonce: nonce.toString(), amount: p.amount.toString(), recipient: p.recipient, reason: p.reason, tx });
    nonce++;
  }
  for (const c of st.watch.claims) if (c.verdict) console.log(`claim ${c.flight} by ${c.victim}: ${c.status}${c.verdict.findings.length ? ` [${[...new Set(c.verdict.findings.map((f) => f.rule))].join(", ")}]` : ""}`);
  console.log(`pool: ${toQor(onLedger.balance)} QOR on the ledger, ${st.pending.length} payout(s) waiting for a batch`);
  save("watchtower", st);
}

async function main() {
  do {
    await once();
    if (process.argv.includes("--loop")) await new Promise((r) => setTimeout(r, 30_000));
  } while (process.argv.includes("--loop"));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
