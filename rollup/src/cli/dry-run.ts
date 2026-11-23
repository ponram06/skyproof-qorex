/**
 * The whole SkyProof flow, offline, before any test QOR is spent:
 * throwaway keys, real-format qor1 addresses, every demo scenario, the real
 * post-size limit, the ledger, the watchtower and the payouts.
 *
 * It does not touch the chain and needs no wallet. Exit code 1 on any surprise.
 */
import { encodeQledgerDeposit, generateMnemonic, presets, rollupModeErrors, validateRollupConfig, type QledgerEntry } from "@qorechain/rdk";
import { canonical, enc, hex, sha256 } from "../util.js";

process.env.QORE_MNEMONIC = generateMnemonic();
const { account, droneKey, kemKey, poolKey } = await import("../keys.js");
const { GENESIS } = await import("../flight/record.js");
const { claimPost, droneRegPost, exitPost } = await import("../flight/posts.js");
const { DEMO_PERMIT, fly, SCENARIOS } = await import("../flight/scenarios.js");
const { MAX_POST, sealSegment } = await import("../flight/segment.js");
const { checkBatch, executeBatch, QledgerLedger, withdrawTx } = await import("../ledger.js");
const { decide, emptyState, judgeFlight, readPosts } = await import("../watchtower.js");
const { EMPTY_INBOX_ACC, inboxRangeHash, qledgerAccumulate } = await import("@qorechain/rdk");

const ENV = { chainId: "qorechain-diana", rollupId: "skyproof-1" };
const QOR = 1_000_000n;
const EXPECT: Record<string, string> = { normal: "rejected", geofence: "paid", altitude: "paid", override: "paid", unapproved: "paid", wind: "paid" };
let failures = 0;
const fail = (m: string) => {
  failures++;
  console.log(`  ✖ ${m}`);
};

// 1. The rollup config the chain will see.
const cfg = presets.nft({ rollupId: ENV.rollupId }).get();
const modeErrs = rollupModeErrors(cfg);
const valid = validateRollupConfig(cfg);
console.log(`rollup config: ${modeErrs.length === 0 && valid.valid ? "accepted" : "REFUSED"} (optimistic, qledger-v1, based)`);
[...modeErrs, ...valid.errors].forEach(fail);

// 2. Accounts and keys.
const [op, inv, ins, victim] = await Promise.all((["operator", "investigator", "insurer", "victim"] as const).map(account));
const drone = droneKey("SKY-001");
const pool = poolKey();
const recipients = [
  { member: inv.address, encapsulationKey: kemKey("investigator").publicKey },
  { member: ins.address, encapsulationKey: kemKey("insurer").publicKey },
];
const member = { address: inv.address, decapsulationKey: kemKey("investigator").seed };
console.log(`roles: operator ${op.address.slice(0, 12)}…, victim ${victim.address.slice(0, 12)}…`);

// 3. Every scenario through posts → watchtower → payouts → ledger.
const entries: QledgerEntry[] = [
  { height: 1, poster: `deposit:${op.address}`, payload: encodeQledgerDeposit(pool.accountId, 50n * QOR) },
  { height: 2, poster: op.address, payload: droneRegPost({ drone: "SKY-001", permit: DEMO_PERMIT }, drone.publicKey) },
];
const permitHash = hex(sha256(enc.encode(canonical(DEMO_PERMIT))));
let maxPost = 0;
let posts = 0;
const flights: Record<string, string> = {};
for (const s of [...SCENARIOS, "withheld"] as const) {
  const scenario = s === "withheld" ? "normal" : s;
  const flight = `SKY-001-${s}`;
  flights[flight] = s;
  const recs = fly(scenario, flight, "SKY-001", permitHash, 1_795_000_000_000);
  let prev = hex(GENESIS);
  for (let i = 0, idx = 0; i < recs.length; i += 12, idx++) {
    const seg = sealSegment({ ...ENV, recipients }, { id: "SKY-001", secretKey: drone.secretKey }, { flight, idx, prev, recs: recs.slice(i, i + 12) });
    maxPost = Math.max(maxPost, seg.bodyPost.length, seg.headerPost.length);
    if (!(s === "withheld" && idx === 1)) entries.push({ height: 3, poster: op.address, payload: seg.bodyPost });
    entries.push({ height: 3, poster: op.address, payload: seg.headerPost });
    posts += 2;
    prev = seg.header.head;
  }
  entries.push({ height: 4, poster: victim.address, payload: claimPost({ flight, note: "dry run" }) });
}
entries.push({ height: 5, poster: op.address, payload: exitPost(10n * QOR) });
console.log(`posts: ${posts} flight posts, largest ${maxPost} B (limit ${MAX_POST})`);
if (maxPost > MAX_POST) fail("a post is over the size limit");

const st = emptyState();
readPosts(st, entries, op.address);
if (st.rejectedPosts.length) st.rejectedPosts.forEach((r) => fail(`rejected post: ${r}`));

const ledger0 = executeBatch(ENV, new QledgerLedger(), entries).ledger;
const payouts = decide(st, (f) => judgeFlight(st, f, ENV, member)?.verdict, ledger0.get(pool.accountId).balance, 5n * QOR);
for (const c of st.claims) {
  const s = flights[c.flight];
  const want = s === "withheld" ? "paid" : EXPECT[s];
  const rules = [...new Set(c.verdict?.findings.map((f) => f.rule) ?? [])].join(", ") || "no rule broken";
  console.log(`  ${c.status === want ? "✔" : "✖"} ${s.padEnd(10)} → ${c.status.padEnd(8)} ${rules}`);
  if (c.status !== want) fail(`${s}: expected ${want}, got ${c.status}`);
}
// Every claim was settled this round, so the bond exit is paid, and only after the victims.
if (st.exits[0]?.status !== "paid" || payouts[payouts.length - 1]?.reason !== "operator bond exit") fail("the bond exit should be paid last, after every victim");

// 4. The judge's payouts as ledger withdrawals, checked by the watchtower.
const payoutEntries: QledgerEntry[] = payouts.map((p, i) => ({ height: 10, poster: op.address, payload: withdrawTx(ENV, pool, BigInt(i), p.recipient, p.amount) }));
const { result, ledger } = executeBatch(ENV, ledger0, payoutEntries);
const paid = result.withdrawals.reduce((s, w) => s + w.amount, 0n);
console.log(`payouts: ${result.withdrawals.length} withdrawal(s), ${paid / QOR} QOR; pool left ${ledger.get(pool.accountId).balance / QOR} QOR`);
if (result.withdrawals.length !== payouts.length) fail("not every payout became a withdrawal");

const accFrom = qledgerAccumulate({ ...ENV, from: 0, accFrom: EMPTY_INBOX_ACC, entries });
const accTo = qledgerAccumulate({ ...ENV, from: entries.length, accFrom, entries: payoutEntries });
const dataHash = inboxRangeHash({ ...ENV, from: entries.length, to: entries.length + payoutEntries.length, accFrom, accTo });
const claim = { inboxStart: BigInt(entries.length), inboxEnd: BigInt(entries.length + payoutEntries.length), dataHash, prevStateRoot: ledger0.root(), stateRoot: result.stateRoot, withdrawalsRoot: result.withdrawalsRoot };
const honest = checkBatch(ENV, ledger0, accFrom, payoutEntries, claim);
const cheat = checkBatch(ENV, ledger0, accFrom, payoutEntries, { ...claim, stateRoot: ledger0.root(), withdrawalsRoot: new Uint8Array() });
console.log(`watchtower: honest batch ${honest.valid ? "accepted" : "CHALLENGED"}, batch that skips the payouts ${cheat.valid ? "ACCEPTED" : "challenged with a fraud proof"}`);
if (!honest.valid || cheat.valid) fail("watchtower check");

console.log(failures ? `\n${failures} problem(s): fix before spending test QOR` : "\ndry run clean: safe to go on chain");
process.exit(failures ? 1 : 0);
