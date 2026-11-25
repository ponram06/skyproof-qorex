import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeQledgerDeposit, qledgerKeypairFromSeed, type QledgerEntry } from "@qorechain/rdk";
import { GENESIS, type FlightRecord } from "../flight/record.js";
import { claimPost, decisionPost, droneRegPost, exitPost } from "../flight/posts.js";
import { sealSegment } from "../flight/segment.js";
import { executeBatch, QledgerLedger, withdrawTx } from "../ledger.js";
import { hex } from "../util.js";
import { CLAIM_DEPOSIT_UQOR, decide, DEPOSIT_REQUIRED_FROM, emptyState, judgeFlight, readPosts, RECORD_GRACE_BLOCKS } from "../watchtower.js";
import { auditBatch, type AuditState } from "../audit.js";
import { cleanFlight, DRONE, ENV, fixedRandom, INVESTIGATOR, PERMIT, RECIPIENTS } from "./fixtures.js";

const CREATOR = "qor1crs332umw4zr9adcegafrc0yr8juke7t7rsre5";
const VICTIM = "qor1xynqax3jn65dekatcxqmfwpyh84xtgzl8y4mmn";
const QOR = 1_000_000n;
const member = { address: INVESTIGATOR.address, decapsulationKey: INVESTIGATOR.seed };

function flightPosts(recs: FlightRecord[], opts: { withhold?: number; poster?: string } = {}): QledgerEntry[] {
  const out: QledgerEntry[] = [];
  let prev = hex(GENESIS);
  for (let i = 0, idx = 0; i < recs.length; i += 8, idx++) {
    const s = sealSegment({ ...ENV, recipients: RECIPIENTS }, { id: DRONE.id, secretKey: DRONE.secretKey }, { flight: "F1", idx, prev, recs: recs.slice(i, i + 8) }, fixedRandom);
    if (opts.withhold !== idx) out.push({ height: 10, poster: CREATOR, payload: s.bodyPost });
    out.push({ height: 10, poster: CREATOR, payload: s.headerPost });
    prev = s.header.head;
  }
  return out;
}
const reg = (poster = CREATOR): QledgerEntry => ({ height: 1, poster, payload: droneRegPost({ drone: DRONE.id, permit: PERMIT }, DRONE.publicKey) });
const claim = (): QledgerEntry => ({ height: 20, poster: VICTIM, payload: claimPost({ flight: "F1", note: "hit" }) });

function run(entries: QledgerEntry[]) {
  const st = emptyState();
  readPosts(st, entries, CREATOR);
  const payouts = decide(st, (f) => judgeFlight(st, f, ENV, member)?.verdict, 50n * QOR, 5n * QOR);
  return { st, payouts };
}

test("an honest flight: the claim is rejected and nothing is paid", () => {
  const { st, payouts } = run([reg(), ...flightPosts(cleanFlight()), claim()]);
  assert.equal(payouts.length, 0);
  assert.equal(st.claims[0].status, "rejected");
});

test("an override: the victim is paid from the pool", () => {
  const recs = cleanFlight();
  (recs.find((r) => r.k === "DECISION" && r.req === "r2") as { ok: boolean }).ok = false;
  const { st, payouts } = run([reg(), ...flightPosts(recs), claim()]);
  assert.deepEqual(payouts.map((p) => [p.recipient, p.amount]), [[VICTIM, 5n * QOR]]);
  assert.equal(st.claims[0].status, "paid");
  assert.ok(payouts[0].reason.includes("B4_OVERRIDE"));
});

test("a withheld segment counts against the operator (B5)", () => {
  const { st, payouts } = run([reg(), ...flightPosts(cleanFlight(), { withhold: 1 }), claim()]);
  assert.equal(payouts.length, 1);
  assert.ok(st.claims[0].verdict!.findings.some((f) => f.rule === "B5_RECORD_BROKEN" && f.detail.includes("withheld")));
});

test("a claim from an address the ledger cannot pay is refused up front", () => {
  const { st } = run([reg(), ...flightPosts(cleanFlight()), { ...claim(), poster: "qor1notreal" }]);
  assert.equal(st.claims.length, 0);
  assert.ok(st.rejectedPosts.some((r) => r.includes("not a payable")));
});

test("a drone registered by someone else is ignored, so its flights cannot be judged", () => {
  const { st, payouts } = run([reg("qor1attacker"), ...flightPosts(cleanFlight()), claim()]);
  assert.equal(payouts.length, 0);
  assert.equal(st.claims[0].status, "open");
  assert.ok(st.rejectedPosts.length > 0);
});

test("a bond exit waits for open claims, then the payout is a real ledger withdrawal", () => {
  const recs = cleanFlight();
  (recs.find((r) => r.k === "ACTION" && r.req === "r2") as { t: number }).t += 60_000;
  const entries = [reg(), ...flightPosts(recs), { height: 21, poster: CREATOR, payload: exitPost(20n * QOR) }];
  // Exit before the flight's claim is known: paid, nothing is open.
  const a = run(entries);
  assert.deepEqual(a.payouts.map((p) => p.reason), ["operator bond exit"]);

  // With an open claim on an unpublished flight, the exit waits.
  const st = emptyState();
  readPosts(st, [{ ...claim(), payload: claimPost({ flight: "F9", note: "" }) }, entries[entries.length - 1]], CREATOR);
  assert.equal(decide(st, () => undefined, 50n * QOR, 5n * QOR).length, 0);

  // The judge's payout executes on the ledger.
  const pool = qledgerKeypairFromSeed(new Uint8Array(32).fill(5));
  const { result } = executeBatch(ENV, new QledgerLedger(), [
    { height: 1, poster: "deposit:qor1operator", payload: encodeQledgerDeposit(pool.accountId, 50n * QOR) },
    { height: 2, poster: "qor1judge", payload: withdrawTx(ENV, pool, 0n, CREATOR, a.payouts[0].amount) },
  ]);
  assert.equal(result.withdrawals[0].amount, 20n * QOR);
});

/* ---------- a claimed flight the operator never publishes ---------- */

test("a claim on a flight with no record waits, then goes to the insurer marked missing", () => {
  const st = emptyState();
  const P = qledgerKeypairFromSeed(new Uint8Array(32).fill(5));
  const h = DEPOSIT_REQUIRED_FROM + 10;
  readPosts(
    st,
    [
      { height: h, poster: `deposit:${VICTIM}`, payload: encodeQledgerDeposit(P.accountId, CLAIM_DEPOSIT_UQOR) },
      { height: h, poster: VICTIM, payload: claimPost({ flight: "SKY-001@2026-11-24T10:00", note: "hit", drone: "SKY-001", when: "2026-11-24T10:00" }) },
      { height: h + 1, poster: CREATOR, payload: exitPost(20n * QOR) },
    ],
    CREATOR,
    { poolAccount: hex(P.accountId), insurer: "qor1insurer" },
  );
  assert.equal(st.claims[0].drone, "SKY-001");
  // Inside the grace period: still open, and the operator's exit waits.
  assert.equal(decide(st, () => undefined, 50n * QOR, 5n * QOR, h + RECORD_GRACE_BLOCKS - 1).length, 0);
  assert.equal(st.claims[0].status, "open");
  // After it: the insurer decides, and the exit still waits for that decision.
  assert.equal(decide(st, () => undefined, 50n * QOR, 5n * QOR, h + RECORD_GRACE_BLOCKS).length, 0);
  assert.equal(st.claims[0].status, "review");
  assert.equal(st.claims[0].missing, true);
  readPosts(st, [{ height: h + 2000, poster: "qor1insurer", payload: decisionPost({ flight: "SKY-001@2026-11-24T10:00", victim: VICTIM, approve: true, reason: "no record for a drone seen by witnesses" }) }], CREATOR, { insurer: "qor1insurer" });
  const out = decide(st, () => undefined, 50n * QOR, 5n * QOR, h + 2000);
  assert.deepEqual(out.map((p) => p.amount), [6n * QOR, 20n * QOR]);
  assert.equal(out[1].reason, "operator bond exit");
});

/* ---------- deposits and insurer review (claims from DEPOSIT_REQUIRED_FROM on) ---------- */

const POOL = qledgerKeypairFromSeed(new Uint8Array(32).fill(5));
const INSURER = "qor1hcpn88ydjgd94t9tm7rzxkuqnjaprqj57jngej";
const H = DEPOSIT_REQUIRED_FROM + 10;
const deposit = (amount = CLAIM_DEPOSIT_UQOR, to = POOL.accountId): QledgerEntry => ({ height: H, poster: `deposit:${VICTIM}`, payload: encodeQledgerDeposit(to, amount) });
const newClaim = (): QledgerEntry => ({ height: H, poster: VICTIM, payload: claimPost({ flight: "F1", note: "hit", when: "2026-11-24T10:00", where: "Main St", evidence: "ab".repeat(32) }) });
const decision = (approve: boolean, poster = INSURER): QledgerEntry => ({ height: H + 5, poster, payload: decisionPost({ flight: "F1", victim: VICTIM, approve, reason: approve ? "photo matches" : "no damage" }) });
const overrideFlight = () => {
  const recs = cleanFlight();
  (recs.find((r) => r.k === "DECISION" && r.req === "r2") as { ok: boolean }).ok = false;
  return recs;
};
const opts = { poolAccount: hex(POOL.accountId), insurer: INSURER };

function runNew(...rounds: QledgerEntry[][]) {
  const st = emptyState();
  const payouts = [];
  for (const entries of rounds) {
    readPosts(st, entries, CREATOR, opts);
    payouts.push(...decide(st, (f) => judgeFlight(st, f, ENV, member)?.verdict, 50n * QOR, 5n * QOR));
  }
  return { st, payouts };
}

test("a new claim without its 1 QOR deposit is refused", () => {
  const { st } = runNew([reg(), ...flightPosts(overrideFlight()), newClaim()]);
  assert.equal(st.claims.length, 0);
  assert.ok(st.rejectedPosts.some((r) => r.includes("deposit")));
});

test("a deposit to some other account does not back a claim", () => {
  const { st } = runNew([reg(), ...flightPosts(overrideFlight()), deposit(CLAIM_DEPOSIT_UQOR, new Uint8Array(32).fill(9)), newClaim()]);
  assert.equal(st.claims.length, 0);
});

test("rule broken: the victim gets the payout plus the deposit back", () => {
  const { st, payouts } = runNew([reg(), ...flightPosts(overrideFlight()), deposit(), newClaim()]);
  assert.deepEqual(payouts.map((p) => [p.recipient, p.amount]), [[VICTIM, 6n * QOR]]);
  assert.equal(st.claims[0].status, "paid");
  assert.equal(st.claims[0].evidence, "ab".repeat(32));
});

test("no rule broken: the claim goes to the insurer, who approves it", () => {
  const first = runNew([reg(), ...flightPosts(cleanFlight()), deposit(), newClaim()]);
  assert.equal(first.payouts.length, 0);
  assert.equal(first.st.claims[0].status, "review");
  const { st, payouts } = runNew([reg(), ...flightPosts(cleanFlight()), deposit(), newClaim()], [decision(true)]);
  assert.deepEqual(payouts.map((p) => [p.recipient, p.amount]), [[VICTIM, 6n * QOR]]);
  assert.equal(st.claims[0].status, "paid");
  assert.ok(payouts[0].reason.includes("approved by the insurer"));
});

test("the insurer rejects a false claim: nothing is paid and the deposit stays in the pool", () => {
  const { st, payouts } = runNew([reg(), ...flightPosts(cleanFlight()), deposit(), newClaim()], [decision(false)]);
  assert.equal(payouts.length, 0);
  assert.equal(st.claims[0].status, "rejected");
  assert.equal(st.claims[0].decision?.approve, false);
});

test("only the insurer can decide, and only a claim in review", () => {
  const { st, payouts } = runNew([reg(), ...flightPosts(cleanFlight()), deposit(), newClaim()], [decision(true, "qor1someoneelse")]);
  assert.equal(payouts.length, 0);
  assert.equal(st.claims[0].status, "review");
  // A decision on a breached (already paid) claim changes nothing.
  const paid = runNew([reg(), ...flightPosts(overrideFlight()), deposit(), newClaim()], [decision(false)]);
  assert.equal(paid.st.claims[0].status, "paid");
});

test("one deposit backs one claim", () => {
  const second = { ...newClaim(), payload: claimPost({ flight: "F2", note: "again" }) };
  const { st } = runNew([reg(), ...flightPosts(cleanFlight()), deposit(), newClaim(), second]);
  assert.equal(st.claims.length, 1);
});

test("a bond exit waits while a claim is in review", () => {
  const exit: QledgerEntry = { height: H + 1, poster: CREATOR, payload: exitPost(20n * QOR) };
  const { payouts } = runNew([reg(), ...flightPosts(cleanFlight()), deposit(), newClaim(), exit]);
  assert.equal(payouts.length, 0);
});

test("malformed posts are ignored, not fatal", () => {
  const bad = (s: string): QledgerEntry => ({ height: H, poster: VICTIM, payload: new Uint8Array([...new TextEncoder().encode(s)]) });
  const { st } = runNew([bad("SKYC1{not json"), bad("SKYC1[1,2]"), bad('SKYC1{"note":"no flight"}'), bad("SKYI1null")]);
  assert.equal(st.claims.length, 0);
});

/* ---------- paying another address ---------- */

test("a claim can send its payout to the victim's own address; an unpayable one is refused", () => {
  const P = qledgerKeypairFromSeed(new Uint8Array(32).fill(5));
  const recs = cleanFlight();
  (recs.find((r) => r.k === "DECISION" && r.req === "r2") as { ok: boolean }).ok = false;
  const OWN = "qor1crs332umw4zr9adcegafrc0yr8juke7t7rsre5";
  const h = DEPOSIT_REQUIRED_FROM + 10;
  const dep = (who: string): QledgerEntry => ({ height: h, poster: `deposit:${who}`, payload: encodeQledgerDeposit(P.accountId, CLAIM_DEPOSIT_UQOR) });
  const st = emptyState();
  readPosts(
    st,
    [reg(), ...flightPosts(recs), dep(VICTIM), { height: h, poster: VICTIM, payload: claimPost({ flight: "F1", note: "hit", payTo: OWN }) }, dep(CREATOR), { height: h, poster: CREATOR, payload: claimPost({ flight: "F1", note: "x", payTo: "qor1notreal" }) }],
    CREATOR,
    { poolAccount: hex(P.accountId) },
  );
  assert.equal(st.claims.length, 1);
  assert.ok(st.rejectedPosts.some((r) => r.includes("not a payable")));
  const out = decide(st, (f) => judgeFlight(st, f, ENV, member)?.verdict, 50n * QOR, 5n * QOR);
  assert.deepEqual(out.map((p) => [p.recipient, p.amount]), [[OWN, 6n * QOR]]);
  assert.equal(st.claims[0].victim, VICTIM);
});

/* ---------- the payout audit ---------- */

test("the audit matches each pool payout to what was owed, and flags one that wasn't", () => {
  const P = qledgerKeypairFromSeed(new Uint8Array(32).fill(5));
  const recs = cleanFlight();
  (recs.find((r) => r.k === "DECISION" && r.req === "r2") as { ok: boolean }).ok = false;
  const st: AuditState = { watch: emptyState(), owed: [], rows: [] };
  const ctx = (now: number) => ({ creator: CREATOR, read: { poolAccount: hex(P.accountId) }, env: ENV, payoutUqor: 5n * QOR, now });
  const judgeOne = (f: string) => judgeFlight(st.watch, f, ENV, member)?.verdict;
  // Batch 0: the breached flight and its claim. Batch 1: the judge pays the victim and also pays itself.
  auditBatch(st, [reg(), ...flightPosts(recs), claim()], 0, ctx(20), judgeOne);
  assert.deepEqual(st.owed.map((o) => [o.recipient, o.amount]), [[VICTIM, (5n * QOR).toString()]]);
  auditBatch(
    st,
    [
      { height: 30, poster: "qor1judge", payload: withdrawTx(ENV, P, 0n, VICTIM, 5n * QOR) },
      { height: 30, poster: "qor1judge", payload: withdrawTx(ENV, P, 1n, "qor1crs332umw4zr9adcegafrc0yr8juke7t7rsre5", 40n * QOR) },
    ],
    1,
    ctx(30),
    judgeOne,
  );
  assert.deepEqual(st.rows.map((r) => r.justified), [true, false]);
  assert.ok(st.rows[0].reason.includes("B4_OVERRIDE"));
  assert.equal(st.owed.length, 0);
});
