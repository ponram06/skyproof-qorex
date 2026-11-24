/**
 * Export the website's data, read back from the chain: every batch, every
 * SkyProof post in it (drone registration, signed segment headers, claims),
 * plus the watchtower's verdicts and executed withdrawals. Sealed bodies are
 * not exported: the site shows that they exist, not what they say.
 * Usage: export-web  →  ../web/public/skyproof.json
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { EMPTY_INBOX_ACC, fetchQledgerEntries, isRestNotFound, qledgerAccumulate, decodeQledgerTx, decodeQledgerDeposit } from "@qorechain/rdk";
import { rdk, ROLLUP_ID } from "../config.js";
import { parseClaim, parseDecision, parseDroneReg, parseExit } from "../flight/posts.js";
import { account, poolKey } from "../keys.js";
import { isBodyPost, isHeaderPost, parseHeaderPost } from "../flight/segment.js";
import { load } from "../state.js";
import { hex, sha256 } from "../util.js";
import { CLAIM_DEPOSIT_UQOR, type WatchState } from "../watchtower.js";

async function main() {
  const env = { chainId: rdk.network.chainId, rollupId: ROLLUP_ID };
  const rollup = await rdk.rest.getRollup(ROLLUP_ID);
  let latest = -1;
  try {
    latest = (await rdk.rest.getLatestBatch(ROLLUP_ID)).batchIndex;
  } catch (e) {
    if (!isRestNotFound(e)) throw e;
  }

  const drones: Record<string, unknown> = {};
  const bodies: Record<string, string> = {};
  const headers: { batch: number; seq: number; height: number; post: string }[] = [];
  const posts: { batch: number; seq: number; height: number; poster: string; kind: string; detail: string }[] = [];
  const batches = [];
  let acc: Uint8Array = EMPTY_INBOX_ACC;

  for (let i = 0; i <= latest; i++) {
    const b = await rdk.rest.getBatch(ROLLUP_ID, i);
    const entries = await fetchQledgerEntries(rdk.rest, { ...env, from: b.inboxStart, to: b.inboxEnd, accFrom: acc });
    acc = qledgerAccumulate({ ...env, from: b.inboxStart, accFrom: acc, entries });
    entries.forEach((e, k) => {
      const seq = b.inboxStart + k + 1;
      const base = { batch: i, seq, height: Number(e.height), poster: e.poster };
      const p = e.payload;
      const reg = parseDroneReg(p);
      if (reg) {
        drones[reg.drone] = { publicKey: hex(reg.publicKey), permit: reg.permit, registeredBy: e.poster };
        posts.push({ ...base, kind: "drone", detail: reg.drone });
      } else if (isHeaderPost(p)) {
        const h = parseHeaderPost(p).header;
        headers.push({ batch: i, seq, height: Number(e.height), post: hex(p) });
        posts.push({ ...base, kind: "header", detail: `${h.flight} #${h.idx}` });
      } else if (isBodyPost(p)) {
        // The ciphertext is public on chain already; only an ML-KEM key holder can open it.
        bodies[hex(sha256(p))] = hex(p);
        posts.push({ ...base, kind: "sealed body", detail: `${p.length} B, sha256 ${hex(sha256(p)).slice(0, 16)}…` });
      }
      else if (parseClaim(p)) posts.push({ ...base, kind: "claim", detail: parseClaim(p)!.flight });
      else if (parseDecision(p)) posts.push({ ...base, kind: "insurer decision", detail: `${parseDecision(p)!.approve ? "approved" : "rejected"} ${parseDecision(p)!.flight}` });
      else if (parseExit(p) !== undefined) posts.push({ ...base, kind: "bond exit", detail: `${parseExit(p)} uqor` });
      else if (decodeQledgerDeposit(p)) posts.push({ ...base, kind: "deposit", detail: `${decodeQledgerDeposit(p)!.amount} uqor` });
      else if (decodeQledgerTx(p)) {
        const t = decodeQledgerTx(p)!;
        posts.push({ ...base, kind: t.recipient ? "withdrawal" : "transfer", detail: `${t.amount} uqor${t.recipient ? ` → ${t.recipient}` : ""}` });
      } else posts.push({ ...base, kind: "other", detail: `${p.length} B` });
    });
    batches.push({
      index: b.batchIndex,
      status: b.status,
      inboxStart: b.inboxStart,
      inboxEnd: b.inboxEnd,
      txCount: b.txCount,
      stateRoot: b.stateRoot,
      withdrawalsRoot: b.withdrawalsRoot,
      submittedTime: b.submittedTime,
      finalizedAt: b.finalizedAt,
    });
  }

  // Fraud proofs the chain upheld against this rollup, read from the event index.
  const fraud: { tx: string; height: number; batch: string; challenger: string; slashed: string; burned: string }[] = [];
  const q = encodeURIComponent(`rdk_fraud_upheld.rollup_id='${ROLLUP_ID}'`);
  const found = (await fetch(`${rdk.network.endpoints.rest}/cosmos/tx/v1beta1/txs?query=${q}&pagination.limit=50`).then((r) => r.json()).catch(() => ({}))) as {
    tx_responses?: { txhash: string; height: string; events: { type: string; attributes: { key: string; value: string }[] }[] }[];
  };
  for (const r of found.tx_responses ?? [])
    for (const e of r.events.filter((x) => x.type === "rdk_fraud_upheld")) {
      const a = Object.fromEntries(e.attributes.map((x) => [x.key, x.value]));
      fraud.push({ tx: r.txhash, height: Number(r.height), batch: a.batch_index, challenger: a.challenger, slashed: a.slashed, burned: a.burned });
    }

  const tower = load<{ watch?: WatchState; log?: unknown[]; pending?: unknown[] }>("watchtower", {});
  const submitter = load<{ batches?: { index: number; withdrawals: unknown[]; tx: string }[] }>("submitter", {});
  const out = {
    generatedAt: new Date().toISOString(),
    chainId: env.chainId,
    rollup,
    drones,
    batches: batches.map((b) => ({ ...b, tx: submitter.batches?.find((s) => s.index === b.index)?.tx, withdrawals: submitter.batches?.find((s) => s.index === b.index)?.withdrawals ?? [] })),
    headers,
    bodies,
    posts,
    claims: tower.watch?.claims ?? [],
    // What the website needs to file a claim (deposit into the pool) and to show the insurer desk.
    claimsPool: { account: hex(poolKey().accountId), depositUqor: CLAIM_DEPOSIT_UQOR.toString(), payoutUqor: "5000000" },
    insurer: (await account("insurer")).address,
    watchtower: tower.log ?? [],
    withdrawalsExecuted: load("withdrawals", {}),
    fraud,
  };
  const dir = resolve(process.cwd(), "../web/public");
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, "skyproof.json"), JSON.stringify(out, null, 1));
  console.log(`exported ${batches.length} batches, ${headers.length} signed headers, ${posts.length} posts, ${out.claims.length} claims`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
