import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EMPTY_INBOX_ACC,
  encodeQledgerDeposit,
  inboxRangeHash,
  qledgerAccountId,
  qledgerAccumulate,
  qledgerKeypairFromSeed,
  qledgerWithdrawalLeaf,
  qledgerWithdrawalsRoot,
  type QledgerEntry,
} from "@qorechain/rdk";
import { GENESIS } from "../flight/record.js";
import { sealSegment } from "../flight/segment.js";
import { checkBatch, executeBatch, QledgerLedger, withdrawalProof, withdrawTx, type BatchClaim } from "../ledger.js";
import { hex } from "../util.js";
import { cleanFlight, DRONE, ENV, fixedRandom, RECIPIENTS } from "./fixtures.js";

const POOL = qledgerKeypairFromSeed(new Uint8Array(32).fill(5));
const VICTIM = "qor1xynqax3jn65dekatcxqmfwpyh84xtgzl8y4mmn";
const QOR = 1_000_000n;

function inbox(): QledgerEntry[] {
  const seg = sealSegment({ ...ENV, recipients: RECIPIENTS }, { id: DRONE.id, secretKey: DRONE.secretKey }, { flight: "F1", idx: 0, prev: hex(GENESIS), recs: cleanFlight() }, fixedRandom);
  return [
    { height: 100, poster: "deposit:qor1operator", payload: encodeQledgerDeposit(POOL.accountId, 50n * QOR) },
    { height: 101, poster: "qor1operator", payload: seg.bodyPost },
    { height: 101, poster: "qor1operator", payload: seg.headerPost },
    { height: 102, poster: "qor1judge", payload: withdrawTx(ENV, POOL, 0n, VICTIM, 5n * QOR) },
  ];
}

test("a deposit funds the pool, flight posts are no-ops, a payout becomes a withdrawal", () => {
  const { result, ledger } = executeBatch(ENV, new QledgerLedger(), inbox());
  assert.equal(ledger.get(POOL.accountId).balance, 45n * QOR);
  assert.equal(ledger.get(POOL.accountId).nonce, 1n);
  assert.deepEqual(result.withdrawals, [{ index: 0n, recipient: VICTIM, amount: 5n * QOR }]);
  assert.deepEqual(result.withdrawalsRoot, qledgerWithdrawalsRoot(ENV.chainId, ENV.rollupId, result.withdrawals));
});

test("a payout signed by the wrong key moves nothing", () => {
  const thief = qledgerKeypairFromSeed(new Uint8Array(32).fill(6));
  const entries = inbox();
  entries[3] = { ...entries[3], payload: withdrawTx(ENV, thief, 0n, VICTIM, 5n * QOR) };
  const { result, ledger } = executeBatch(ENV, new QledgerLedger(), entries);
  assert.equal(result.withdrawals.length, 0);
  assert.equal(ledger.get(POOL.accountId).balance, 50n * QOR);
  assert.notDeepEqual(qledgerAccountId(thief.publicKey), POOL.accountId);
});

test("the watchtower accepts an honest batch", () => {
  const entries = inbox();
  const { result } = executeBatch(ENV, new QledgerLedger(), entries);
  const claim = claimOf(result.stateRoot, result.withdrawalsRoot, entries.length);
  assert.equal(checkBatch(ENV, new QledgerLedger(), EMPTY_INBOX_ACC, entries, claim).valid, true);
});

test("the watchtower catches a batch that pays itself and builds a winning fraud proof", () => {
  const entries = inbox();
  // A dishonest submitter publishes the state as if the payout never happened.
  const { result: noPayout } = executeBatch(ENV, new QledgerLedger(), entries.slice(0, 3));
  const claim = claimOf(noPayout.stateRoot, noPayout.withdrawalsRoot, entries.length);
  const check = checkBatch(ENV, new QledgerLedger(), EMPTY_INBOX_ACC, entries, claim);
  assert.equal(check.valid, false);
  if (!check.valid) assert.ok(check.proof.length > 0);
});

test("a withdrawal's Merkle path is built for MsgExecuteWithdrawal", () => {
  const { result } = executeBatch(ENV, new QledgerLedger(), inbox());
  const path = withdrawalProof(ENV, result, 0);
  // One withdrawal: a tree of size 1, so the leaf is the root and the path is empty.
  assert.equal(path.length, 0);
  assert.deepEqual(result.withdrawalsRoot, qledgerWithdrawalLeaf(ENV.chainId, ENV.rollupId, 0n, VICTIM, 5n * QOR));
});

/** The claim a batch consuming all of `inbox()` publishes, with the real inbox range commitment. */
function claimOf(stateRoot: Uint8Array, withdrawalsRoot: Uint8Array, n: number): BatchClaim {
  const entries = inbox().slice(0, n);
  const accTo = qledgerAccumulate({ ...ENV, from: 0, accFrom: EMPTY_INBOX_ACC, entries });
  const dataHash = inboxRangeHash({ ...ENV, from: 0, to: n, accFrom: EMPTY_INBOX_ACC, accTo });
  return { inboxStart: 0n, inboxEnd: BigInt(n), dataHash, prevStateRoot: new QledgerLedger().root(), stateRoot, withdrawalsRoot };
}
