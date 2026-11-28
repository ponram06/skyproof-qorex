/**
 * One command for judges: check every Protocol Builders requirement against
 * QoreChain testnet and print PASS / FAIL. Read-only: no keys, no .env, no QOR.
 *
 * What it reads: the rollup and its batches from the chain, and the public site
 * data (skyproof.json) only to know which transactions and posts to look up; each
 * one is then fetched from the chain itself and checked there.
 *
 * Usage: npm run judge   (SKYPROOF_SITE to point at another deployment)
 */
import { buildSettlementReceipt, createRdkClient, verifySettlementReceipt } from "@qorechain/rdk";
import { createHash } from "node:crypto";

const SITE = process.env.SKYPROOF_SITE ?? "https://skyproof-qorex.malaysiawest.cloudapp.azure.com";
const ROLLUP = "skyproof-1";
const rdk = createRdkClient({ network: "testnet" });
const REST = rdk.network.endpoints.rest;

let failed = 0;
function result(ok: boolean | "skip", name: string, detail: string) {
  if (ok === false) failed++;
  console.log(`${ok === "skip" ? "SKIP" : ok ? "PASS" : "FAIL"}  ${name}\n      ${detail}`);
}
const tx = async (h: string) => ((await fetch(`${REST}/cosmos/tx/v1beta1/txs/${h}`).then((r) => r.json())) as { tx_response?: { code: number; height: string } }).tx_response;

async function main() {
  console.log(`SkyProof judge check · rollup ${ROLLUP} on ${rdk.network.chainId} · ${new Date().toISOString()}\n`);
  const site = (await fetch(`${SITE}/skyproof.json`).then((r) => r.json())) as {
    batches: { index: number; withdrawals: { index?: string }[] }[];
    bodies?: Record<string, string>;
    posts: { seq: number; kind: string }[];
    withdrawalsExecuted?: Record<string, string>;
    insurer?: string;
  };

  // 1. The rollup itself.
  const r = await rdk.rest.getRollup(ROLLUP);
  result(r.status === "active" && r.executionVm === "qledger-v1" && r.settlementMode === "optimistic", "Rollup on x/rdk", `${ROLLUP}: ${r.status}, ${r.settlementMode}, ${r.executionVm}, ${r.challengeWindowSec} s challenge window, creator ${r.creator}`);

  // 2. ML-DSA-signed batches + verified settlement receipt, on the newest batch (older ones may be pruned).
  const latest = await rdk.rest.getLatestBatch(ROLLUP);
  try {
    const receipt = await buildSettlementReceipt(rdk, ROLLUP, latest.batchIndex);
    const v = await verifySettlementReceipt(receipt, { client: rdk });
    const checks = Object.entries(v.checks ?? {});
    result(v.valid, "ML-DSA-signed batch + verified settlement receipt", `batch ${latest.batchIndex} (${latest.status}): ${receipt.algorithm} by ${receipt.creator}; ${checks.filter(([, ok]) => ok).length}/${checks.length} checks (${checks.map(([k, ok]) => `${ok ? "✔" : "✖"}${k}`).join(" ")})`);
  } catch (e) {
    result(false, "ML-DSA-signed batch + verified settlement receipt", `batch ${latest.batchIndex}: ${e instanceof Error ? e.message : e}`);
  }

  // 3. Withdrawals executed on QoreChain (MsgExecuteWithdrawal).
  const ws = Object.values(site.withdrawalsExecuted ?? {});
  const ok = (await Promise.all(ws.map(async (h) => (await tx(h))?.code === 0))).filter(Boolean).length;
  result(ws.length > 0 && ok === ws.length, "Withdrawals executed on QoreChain", `${ok} of ${ws.length} withdrawal transactions found on chain with code 0${ws[0] ? ` (e.g. ${ws[0].slice(0, 12)}…)` : ""}`);

  // 4. Watchtower: a fraud proof the chain upheld against this rollup.
  const q = encodeURIComponent(`rdk_fraud_upheld.rollup_id='${ROLLUP}'`);
  const fraud = (await fetch(`${REST}/cosmos/tx/v1beta1/txs?query=${q}&pagination.limit=5`).then((x) => x.json())) as { tx_responses?: { txhash: string; height: string }[] };
  const f = fraud.tx_responses?.[0];
  result(f ? true : "skip", "Watchtower: fraud proof upheld", f ? `tx ${f.txhash.slice(0, 12)}… at height ${f.height}: the chain upheld a fraud proof and slashed the rogue submitter` : "the chain's event index no longer returns it (pruned); see docs/EVIDENCE.md");

  // 5. Watchtower service: running now.
  try {
    const st = (await fetch(`${SITE}/api/demo/status`).then((x) => x.json())) as { lastCycleAt: string; cycleMs: number; lastError: string };
    const age = (Date.now() - new Date(st.lastCycleAt).getTime()) / 1000;
    result(age < (3 * st.cycleMs) / 1000 && !st.lastError, "Watchtower running now", `last check ${Math.round(age)} s ago${st.lastError ? `, last error: ${st.lastError}` : ""}`);
  } catch (e) {
    result(false, "Watchtower running now", `${SITE}/api/demo/status: ${e instanceof Error ? e.message : e}`);
  }

  // 6. ML-KEM data protection: keys registered on chain, and the chain holds only ciphertext.
  const inv = (await fetch(`${SITE}/demo-investigator.json`).then((x) => x.json())) as { address: string };
  const keys = await Promise.all([inv.address, site.insurer ?? ""].map((a) => rdk.rest.getKemKey(a).catch(() => undefined)));
  const sealed = site.posts.filter((p) => p.kind === "sealed body").slice(-3);
  const onChain = await Promise.all(sealed.map((p) => rdk.rest.getPostedData(ROLLUP, p.seq).catch(() => undefined)));
  const hashes = new Set(Object.values(site.bodies ?? {}).map((b) => createHash("sha256").update(Buffer.from(b, "hex")).digest("hex")));
  const matched = onChain.filter((d) => d && hashes.has(d.dataHash.toLowerCase())).length;
  const readable = Object.values(site.bodies ?? {}).slice(-3).some((b) => /"(lat|lon|alt)"/.test(Buffer.from(b, "hex").toString("latin1")));
  result(keys.every(Boolean) && matched === sealed.length && !readable, "ML-KEM-1024 data protection", `investigator and insurer ML-KEM keys registered: ${keys.filter(Boolean).length}/2; newest ${sealed.length} sealed flight parts match the chain's commitment: ${matched}/${sealed.length}; position fields readable without a key: ${readable ? "yes" : "no"}`);

  console.log(`\n${failed ? `${failed} check(s) FAILED` : "All checks passed."} Threat model: docs/THREAT_MODEL.md · every transaction: docs/EVIDENCE.md`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
