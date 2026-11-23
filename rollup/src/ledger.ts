/**
 * The rollup's ledger (qledger-v1): what the submitter executes to build a
 * batch and what the watchtower re-executes to check one.
 *
 * SkyProof's money lives here: the claims pool holds operator bonds; a payout
 * to a victim and an operator's bond exit are WITHDRAW transactions from the
 * pool, paid on QoreChain with MsgExecuteWithdrawal once their batch is final.
 * Flight segments share the same inbox but are not ledger transactions, so
 * execution skips them.
 */
import {
  buildQledgerFraudProof,
  checkQledgerFraud,
  encodeQledgerTx,
  executeQledger,
  QledgerLedger,
  qledgerWithdrawalProof,
  signQledgerTx,
  type QledgerEntry,
  type QledgerResult,
} from "@qorechain/rdk";
import { equalBytes, hex } from "./util.js";

export interface Env {
  chainId: string;
  rollupId: string;
}

/** Execute a batch's entries on a copy of `parent`. */
export function executeBatch(env: Env, parent: QledgerLedger, entries: QledgerEntry[]): { result: QledgerResult; ledger: QledgerLedger } {
  const ledger = parent.clone();
  const result = executeQledger(env, ledger, entries);
  return { result, ledger };
}

export interface BatchClaim {
  inboxStart: bigint;
  inboxEnd: bigint;
  dataHash: Uint8Array;
  prevStateRoot: Uint8Array;
  stateRoot: Uint8Array;
  withdrawalsRoot: Uint8Array;
}

export type BatchCheck =
  | { valid: true; honest: QledgerResult }
  | { valid: false; honest: QledgerResult; proof: Uint8Array; reason: string };

/**
 * The watchtower's check: re-execute the batch from its parent state. If the
 * published roots differ from the honest ones, return a fraud proof the chain
 * will uphold (checked locally with the chain's own rule first).
 */
export function checkBatch(env: Env, parent: QledgerLedger, accFrom: Uint8Array, entries: QledgerEntry[], claim: BatchClaim): BatchCheck {
  const { proof, honest } = buildQledgerFraudProof(env, parent, accFrom, entries);
  const rootOk = equalBytes(honest.stateRoot, claim.stateRoot);
  const wOk = equalBytes(honest.withdrawalsRoot, claim.withdrawalsRoot);
  if (rootOk && wOk) return { valid: true, honest };
  const upheld = checkQledgerFraud(env, { ...claim }, proof);
  if (!upheld) throw new Error("roots differ but the chain's fraud rule would not uphold the proof");
  return {
    valid: false,
    honest,
    proof,
    reason: !rootOk ? `state root ${hex(claim.stateRoot).slice(0, 16)}… should be ${hex(honest.stateRoot).slice(0, 16)}…` : "withdrawals root is wrong",
  };
}

/** A signed qledger WITHDRAW from `from` to a qor1 address, ready to post. */
export function withdrawTx(
  env: Env,
  from: { publicKey: Uint8Array; secretKey: Uint8Array },
  nonce: bigint,
  recipient: string,
  amountUqor: bigint,
): Uint8Array {
  return encodeQledgerTx(signQledgerTx({ ...env, ...from, nonce, amount: amountUqor, recipient }));
}

/** The Merkle path MsgExecuteWithdrawal needs for withdrawal `i` of a batch. */
export const withdrawalProof = (env: Env, result: QledgerResult, i: number) =>
  qledgerWithdrawalProof(env.chainId, env.rollupId, result.withdrawals, i);

export { QledgerLedger };
