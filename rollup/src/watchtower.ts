/**
 * The watchtower / judge, as pure logic over inbox entries.
 *
 * For every batch it (1) re-executes the ledger and checks the published roots
 * (ledger.ts → fraud proof), and (2) reads SkyProof's own posts:
 *  - drone registrations, honoured only from the rollup's creator;
 *  - segment headers, kept only if the registered drone key signed them;
 *  - sealed bodies, matched to headers by hash and opened with the
 *    investigator's ML-KEM key;
 *  - claims and bond-exit requests.
 * A claimed flight is judged with the six rules. A breach pays the victim from
 * the claims pool; the payout is a qledger WITHDRAW the judge signs.
 */
import { isCanonicalQorAddress, type QledgerEntry } from "@qorechain/rdk";
import type { FlightRecord } from "./flight/record.js";
import { parseClaim, parseDroneReg, parseExit } from "./flight/posts.js";
import { isBodyPost, isHeaderPost, openSegment, parseHeaderPost, verifyHeader, type SegmentHeader } from "./flight/segment.js";
import { judge, type Permit, type Verdict } from "./rules.js";
import { hex, sha256, unhex } from "./util.js";

export interface WatchState {
  drones: Record<string, { publicKey: string; permit: Permit }>;
  /** flight -> segment idx -> header */
  headers: Record<string, Record<number, SegmentHeader>>;
  /** body hash -> body post (hex) */
  bodies: Record<string, string>;
  claims: { flight: string; victim: string; note: string; status: "open" | "paid" | "rejected"; verdict?: Verdict }[];
  exits: { operator: string; amount: string; status: "open" | "paid" }[];
  rejectedPosts: string[];
}
export const emptyState = (): WatchState => ({ drones: {}, headers: {}, bodies: {}, claims: [], exits: [], rejectedPosts: [] });

export function readPosts(st: WatchState, entries: QledgerEntry[], creator: string): void {
  for (const e of entries) {
    const p = e.payload;
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
      if (!st.claims.some((c) => c.flight === claim.flight && c.victim === e.poster))
        st.claims.push({ flight: claim.flight, victim: e.poster, note: claim.note, status: "open" });
      continue;
    }
    const exit = parseExit(p);
    if (exit !== undefined && e.poster === creator) st.exits.push({ operator: e.poster, amount: exit.toString(), status: "open" });
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
 * Decide this round's payouts: every open claim on a breached flight is paid
 * `payoutUqor`; an honest flight's claim is rejected. A bond exit is paid only
 * when no claim is open, and never more than the pool holds.
 */
export function decide(
  st: WatchState,
  judgeOne: (flight: string) => Verdict | undefined,
  poolBalance: bigint,
  payoutUqor: bigint,
): Payout[] {
  const out: Payout[] = [];
  let left = poolBalance;
  for (const c of st.claims.filter((x) => x.status === "open")) {
    const v = judgeOne(c.flight);
    if (!v) continue; // flight not published yet: keep waiting
    c.verdict = v;
    if (!v.breach) {
      c.status = "rejected";
      continue;
    }
    if (left < payoutUqor) continue;
    left -= payoutUqor;
    c.status = "paid";
    out.push({ recipient: c.victim, amount: payoutUqor, reason: `${c.flight}: ${v.findings.map((f) => f.rule).join(", ")}` });
  }
  if (!st.claims.some((c) => c.status === "open")) {
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
