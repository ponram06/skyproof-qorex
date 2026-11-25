/**
 * The watchtower / judge, as pure logic over inbox entries.
 *
 * For every batch it (1) re-executes the ledger and checks the published roots
 * (ledger.ts → fraud proof), and (2) reads SkyProof's own posts:
 *  - drone registrations, honoured only from the rollup's creator;
 *  - segment headers, kept only if the registered drone key signed them;
 *  - sealed bodies, matched to headers by hash and opened with the
 *    investigator's ML-KEM key;
 *  - claims, each backed by a refundable deposit into the claims pool;
 *  - the insurer's decisions on claims sent for review;
 *  - bond-exit requests.
 * A claimed flight is judged with the six rules. A breach pays the victim from
 * the claims pool, plus their deposit back; the payout is a qledger WITHDRAW
 * the judge signs. No breach sends the claim to the insurer: approved → paid
 * the same way; rejected → nothing paid and the deposit stays in the pool.
 */
import { decodeQledgerDeposit, isCanonicalQorAddress, QLEDGER_DEPOSIT_POSTER_PREFIX, type QledgerEntry } from "@qorechain/rdk";
import type { FlightRecord } from "./flight/record.js";
import { parseClaim, parseDecision, parseDroneReg, parseExit } from "./flight/posts.js";
import { isBodyPost, isHeaderPost, openSegment, parseHeaderPost, verifyHeader, type SegmentHeader } from "./flight/segment.js";
import { judge, type Permit, type Verdict } from "./rules.js";
import { equalBytes, hex, sha256, unhex } from "./util.js";

/** The refundable deposit a claim must carry (QoreChain's minimum rollup deposit, 1 QOR). */
export const CLAIM_DEPOSIT_UQOR = 1_000_000n;
/**
 * Claims included before this block were filed before deposits existed: they are
 * still judged, and a claim with no breach is simply rejected (no insurer review).
 * From this block on, a claim without its deposit is refused.
 */
export const DEPOSIT_REQUIRED_FROM = 10_665_000;
/**
 * How long the operator has to publish a claimed flight: 900 blocks, about
 * 30 minutes at QoreChain's 2 s blocks. A claim on a flight that still has no
 * record after that goes to the insurer marked "no record", so withholding a
 * whole flight neither dodges the claim nor leaves it open forever (an open
 * claim holds back bond exits, so it must always reach a decision).
 */
export const RECORD_GRACE_BLOCKS = 900;

export type ClaimStatus = "open" | "review" | "paid" | "rejected";
export interface ClaimState {
  flight: string;
  victim: string;
  note: string;
  status: ClaimStatus;
  verdict?: Verdict;
  /** The deposit (uqor) this claim locked; "0" for claims filed before deposits. */
  deposit?: string;
  height?: number;
  when?: string;
  where?: string;
  evidence?: string;
  /** The insurer's decision, once a reviewed claim is decided. */
  decision?: { approve: boolean; reason: string };
  /** The drone the victim named (optional). */
  drone?: string;
  /** True when the operator published no record of the flight within RECORD_GRACE_BLOCKS. */
  missing?: boolean;
  /** Where the payout goes, when the claimant named an address other than their own. */
  payTo?: string;
}

export interface WatchState {
  drones: Record<string, { publicKey: string; permit: Permit }>;
  /** flight -> segment idx -> header */
  headers: Record<string, Record<number, SegmentHeader>>;
  /** body hash -> body post (hex) */
  bodies: Record<string, string>;
  claims: ClaimState[];
  exits: { operator: string; amount: string; status: "open" | "paid"; height?: number }[];
  rejectedPosts: string[];
  /** Deposits into the claims pool not yet tied to a claim: depositor -> uqor. */
  credits?: Record<string, string>;
}
export const emptyState = (): WatchState => ({ drones: {}, headers: {}, bodies: {}, claims: [], exits: [], rejectedPosts: [], credits: {} });

export interface ReadOptions {
  /** The claims pool's qledger account id (hex): only deposits to it back a claim. */
  poolAccount?: string;
  /** The insurer's address: only its decisions count. */
  insurer?: string;
}

export function readPosts(st: WatchState, entries: QledgerEntry[], creator: string, opts: ReadOptions = {}): void {
  st.credits ??= {};
  // Count this batch's deposits first: a claim's deposit is in the same transaction,
  // and this does not depend on the order the chain writes the two inbox entries.
  for (const e of entries) {
    if (!e.poster.startsWith(QLEDGER_DEPOSIT_POSTER_PREFIX)) continue;
    const d = decodeQledgerDeposit(e.payload);
    if (d && opts.poolAccount && equalBytes(d.account, unhex(opts.poolAccount))) {
      const who = e.poster.slice(QLEDGER_DEPOSIT_POSTER_PREFIX.length);
      st.credits[who] = (BigInt(st.credits[who] ?? "0") + d.amount).toString();
    }
  }
  for (const e of entries) {
    const p = e.payload;
    if (e.poster.startsWith(QLEDGER_DEPOSIT_POSTER_PREFIX)) continue;
    const reg = parseDroneReg(p);
    if (reg) {
      if (e.poster !== creator) st.rejectedPosts.push(`drone ${reg.drone} registered by ${e.poster}, not the rollup creator`);
      else if (!st.drones[reg.drone]) st.drones[reg.drone] = { publicKey: hex(reg.publicKey), permit: reg.permit };
      continue;
    }
    if (isHeaderPost(p)) {
      const h = parseHeaderPost(p);
      const d = st.drones[h.header.drone];
      if (!d || !verifyHeader(h, unhex(d.publicKey))) {
        st.rejectedPosts.push(`header for ${h.header.flight}#${h.header.idx} not signed by a registered drone`);
        continue;
      }
      (st.headers[h.header.flight] ??= {})[h.header.idx] ??= h.header;
      continue;
    }
    if (isBodyPost(p)) {
      st.bodies[hex(sha256(p))] = hex(p);
      continue;
    }
    const claim = parseClaim(p);
    if (claim) {
      // A withdrawal to a non-canonical address is a no-op on the ledger, so it could never be paid.
      if (!isCanonicalQorAddress(e.poster)) {
        st.rejectedPosts.push(`claim from ${e.poster}: not a payable qor1 address`);
        continue;
      }
      if (st.claims.some((c) => c.flight === claim.flight && c.victim === e.poster)) continue;
      // A payout address the ledger could never pay would lock the payout: refuse the claim up front.
      if (claim.payTo !== undefined && !isCanonicalQorAddress(claim.payTo)) {
        st.rejectedPosts.push(`claim from ${e.poster} on ${claim.flight}: payout address ${claim.payTo} is not a payable qor1 address`);
        continue;
      }
      // The deposit is posted in the same transaction, just before the claim, so its credit is already counted.
      const credit = BigInt(st.credits[e.poster] ?? "0");
      const legacy = Number(e.height) < DEPOSIT_REQUIRED_FROM;
      if (!legacy && credit < CLAIM_DEPOSIT_UQOR) {
        st.rejectedPosts.push(`claim from ${e.poster} on ${claim.flight}: no ${CLAIM_DEPOSIT_UQOR / 1_000_000n} QOR deposit`);
        continue;
      }
      const deposit = legacy ? 0n : CLAIM_DEPOSIT_UQOR;
      if (deposit) st.credits[e.poster] = (credit - deposit).toString();
      st.claims.push({
        flight: claim.flight,
        victim: e.poster,
        note: claim.note,
        status: "open",
        deposit: deposit.toString(),
        height: Number(e.height),
        ...(claim.when ? { when: claim.when } : {}),
        ...(claim.where ? { where: claim.where } : {}),
        ...(claim.evidence ? { evidence: claim.evidence } : {}),
        ...(claim.drone ? { drone: claim.drone } : {}),
        ...(claim.payTo && claim.payTo !== e.poster ? { payTo: claim.payTo } : {}),
      });
      continue;
    }
    const decision = parseDecision(p);
    if (decision) {
      if (!opts.insurer || e.poster !== opts.insurer) {
        st.rejectedPosts.push(`decision on ${decision.flight} by ${e.poster}, not the insurer`);
        continue;
      }
      const c = st.claims.find((x) => x.flight === decision.flight && x.victim === decision.victim);
      // The insurer decides only claims the rules sent to review, and only once.
      if (c && c.status === "review" && !c.decision) c.decision = { approve: decision.approve, reason: decision.reason };
      else st.rejectedPosts.push(`decision on ${decision.flight} for ${decision.victim}: no claim waiting for review`);
      continue;
    }
    const exit = parseExit(p);
    // Keyed by inclusion height, so re-reading a batch after a rewind never doubles an exit.
    if (exit !== undefined && e.poster === creator && !st.exits.some((x) => x.height === Number(e.height) && x.amount === exit.toString()))
      st.exits.push({ operator: e.poster, amount: exit.toString(), status: "open", height: Number(e.height) });
  }
}

/** Open and judge a flight with whatever the operator has published. */
export function judgeFlight(
  st: WatchState,
  flight: string,
  ctx: { chainId: string; rollupId: string },
  member: { address: string; decapsulationKey: Uint8Array },
): { verdict: Verdict; recs: FlightRecord[] } | undefined {
  const segs = st.headers[flight];
  if (!segs) return undefined;
  const idxs = Object.keys(segs).map(Number).sort((a, b) => a - b);
  const first = segs[idxs[0]];
  const permit = st.drones[first.drone]?.permit;
  if (!permit) return undefined;

  const errors: string[] = [];
  const recs: FlightRecord[] = [];
  const last = idxs[idxs.length - 1];
  if (!segs[last].fin) errors.push("flight never closed (no final segment)");
  let prevHead = "00".repeat(32);
  for (let i = 0; i <= last; i++) {
    const h = segs[i];
    if (!h) {
      errors.push(`segment ${i} header missing`);
      continue;
    }
    if (h.prev !== prevHead) errors.push(`segment ${i} does not continue segment ${i - 1}`);
    prevHead = h.head;
    const body = st.bodies[h.body];
    if (!body) {
      errors.push(`segment ${i} body withheld`);
      continue;
    }
    try {
      const out = openSegment(ctx, unhex(body), h, member);
      errors.push(...out.errors.map((x) => `segment ${i}: ${x}`));
      recs.push(...out.recs);
    } catch (e) {
      errors.push(`segment ${i}: cannot open (${e instanceof Error ? e.message : e})`);
    }
  }
  return { verdict: judge(recs, permit, errors), recs };
}

export interface Payout {
  recipient: string;
  amount: bigint;
  reason: string;
}

/**
 * Decide this round's payouts:
 *  - an open claim on a breached flight is paid `payoutUqor` plus its deposit back;
 *  - an open claim on a flight with no breach goes to the insurer for review
 *    (claims filed before deposits existed are simply rejected);
 *  - an open claim on a flight the operator has not published RECORD_GRACE_BLOCKS
 *    after the claim (`now` is the chain height) goes to the insurer marked
 *    "no record";
 *  - a reviewed claim the insurer approved is paid the same way; one it rejected
 *    gets nothing, and its deposit stays in the pool.
 * A bond exit is paid only when no claim is open or in review, and never more
 * than the pool holds.
 */
export function decide(
  st: WatchState,
  judgeOne: (flight: string) => Verdict | undefined,
  poolBalance: bigint,
  payoutUqor: bigint,
  now?: number,
): Payout[] {
  const out: Payout[] = [];
  let left = poolBalance;
  const pay = (c: ClaimState, reason: string) => {
    const amount = payoutUqor + BigInt(c.deposit ?? "0");
    if (left < amount) return; // pool short: the claim keeps its status and waits
    left -= amount;
    c.status = "paid";
    out.push({ recipient: c.payTo ?? c.victim, amount, reason });
  };
  for (const c of st.claims.filter((x) => x.status === "open")) {
    const v = judgeOne(c.flight);
    if (!v) {
      // Not published yet: wait, but not forever.
      if (now !== undefined && c.height !== undefined && now - c.height >= RECORD_GRACE_BLOCKS) {
        c.missing = true;
        c.status = BigInt(c.deposit ?? "0") > 0n ? "review" : "rejected";
      }
      continue;
    }
    c.missing = undefined;
    c.verdict = v;
    if (v.breach) pay(c, `${c.flight}: ${[...new Set(v.findings.map((f) => f.rule))].join(", ")}`);
    else c.status = BigInt(c.deposit ?? "0") > 0n ? "review" : "rejected";
  }
  for (const c of st.claims.filter((x) => x.status === "review" && x.decision)) {
    if (c.decision!.approve) pay(c, `${c.flight}: approved by the insurer (${c.decision!.reason})`);
    else c.status = "rejected";
  }
  if (!st.claims.some((c) => c.status === "open" || c.status === "review")) {
    for (const x of st.exits.filter((e) => e.status === "open")) {
      const amt = BigInt(x.amount) < left ? BigInt(x.amount) : left;
      if (amt <= 0n) break;
      left -= amt;
      x.status = "paid";
      out.push({ recipient: x.operator, amount: amt, reason: "operator bond exit" });
    }
  }
  return out;
}
