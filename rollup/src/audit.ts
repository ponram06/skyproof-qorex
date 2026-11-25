/**
 * The payout audit: an independent check that every coin leaving the claims
 * pool was owed to someone.
 *
 * Only the judge holds the claims pool key, and qledger accounts have a single
 * key (no multi-signature). So the chain accepts a payout the judge signs, even
 * an unjustified one. The audit is the counterweight. It rebuilds the
 * watchtower's view on its own from the chain's inbox, batch by batch. Then it
 * works out which payouts the rules and the insurer allowed, and matches each
 * real withdrawal from the pool against them. A payout that matches nothing is
 * flagged in public.
 *
 * This detects a dishonest judge; it cannot stop one. Stopping one needs a
 * multi-signature pool account, which qledger does not offer yet (see the
 * threat model).
 */
import { decodeQledgerTx, QLEDGER_KIND_WITHDRAW, qledgerAccountId, verifyQledgerTx, type QledgerEntry } from "@qorechain/rdk";
import type { Verdict } from "./rules.js";
import { equalBytes, unhex } from "./util.js";
import { decide, readPosts, type ReadOptions, type WatchState } from "./watchtower.js";

export interface PoolWithdrawal {
  nonce: string;
  recipient: string;
  amount: string;
  batch: number;
  height: number;
}

/** Withdrawals signed by the pool's key in these inbox entries (valid signatures only, as the ledger would count them). */
export function poolWithdrawals(entries: QledgerEntry[], poolAccount: string, env: { chainId: string; rollupId: string }, batch: number): PoolWithdrawal[] {
  const out: PoolWithdrawal[] = [];
  for (const e of entries) {
    const tx = decodeQledgerTx(e.payload);
    if (!tx || tx.kind !== QLEDGER_KIND_WITHDRAW || !tx.recipient) continue;
    if (!equalBytes(qledgerAccountId(tx.publicKey, tx.scheme), unhex(poolAccount))) continue;
    if (!verifyQledgerTx(tx, env.chainId, env.rollupId)) continue;
    out.push({ nonce: tx.nonce.toString(), recipient: tx.recipient, amount: tx.amount.toString(), batch, height: Number(e.height) });
  }
  return out;
}

export interface AuditRow extends PoolWithdrawal {
  justified: boolean;
  /** What justified it (a claim and why it was paid, or a bond exit), or why not. */
  reason: string;
}

export interface AuditState {
  watch: WatchState;
  /** Payouts the rules and the insurer allow, not yet matched to a real withdrawal. */
  owed: { recipient: string; amount: string; reason: string }[];
  rows: AuditRow[];
}

/**
 * Feed one batch's inbox entries. Like the watchtower, this reads the posts and
 * then decides, so an insurer decision counts only once its claim is in review.
 * The pool balance is treated as unlimited: the audit asks what is owed, not
 * what is affordable. Withdrawals in this batch are matched against what was
 * owed before it (a payout always comes in a later batch than its claim).
 */
export function auditBatch(
  st: AuditState,
  entries: QledgerEntry[],
  batch: number,
  ctx: { creator: string; read: ReadOptions & { poolAccount: string }; env: { chainId: string; rollupId: string }; payoutUqor: bigint; now: number },
  judgeOne: (flight: string) => Verdict | undefined,
): void {
  for (const w of poolWithdrawals(entries, ctx.read.poolAccount, ctx.env, batch)) {
    const i = st.owed.findIndex((o) => o.recipient === w.recipient && o.amount === w.amount);
    if (i >= 0) {
      st.rows.push({ ...w, justified: true, reason: st.owed[i].reason });
      st.owed.splice(i, 1);
    } else st.rows.push({ ...w, justified: false, reason: "no claim or bond exit owed this payout" });
  }
  const owe = (now: number) => {
    for (const p of decide(st.watch, judgeOne, 1n << 62n, ctx.payoutUqor, now)) st.owed.push({ recipient: p.recipient, amount: p.amount.toString(), reason: p.reason });
  };
  // The chain had reached this batch's first entry: claims past their grace period are in review by now.
  if (entries.length) owe(Math.min(...entries.map((e) => Number(e.height))));
  readPosts(st.watch, entries, ctx.creator, ctx.read);
  owe(ctx.now);
}
