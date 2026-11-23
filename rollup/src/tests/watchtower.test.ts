import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeQledgerDeposit, qledgerKeypairFromSeed, type QledgerEntry } from "@qorechain/rdk";
import { GENESIS, type FlightRecord } from "../flight/record.js";
import { claimPost, droneRegPost, exitPost } from "../flight/posts.js";
import { sealSegment } from "../flight/segment.js";
import { executeBatch, QledgerLedger, withdrawTx } from "../ledger.js";
import { hex } from "../util.js";
import { decide, emptyState, judgeFlight, readPosts } from "../watchtower.js";
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
