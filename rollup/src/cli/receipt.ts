/**
 * Build the settlement receipt for a batch and verify it against live chain
 * state: the batch is anchored on QoreChain under the rollup creator's
 * ML-DSA-87 signature. Saved to receipts/ as evidence.
 *
 * QoreChain prunes old batch data (posted data, and finalized batch records after
 * ~7 days), so a receipt that verified once may later fail to rebuild. When the
 * chain no longer has a batch, this falls back to the receipt saved here: it
 * checks the saved receipt's ML-DSA-87 signature against the creator's key on
 * chain, and shows the full chain verification recorded when it was saved.
 *
 * Usage: receipt <batch>   |   receipt all   (save every batch while the chain still has it)
 *        add --saved to check the saved copies as if the chain had pruned them
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { buildSettlementReceipt, verifySettlementReceipt, type SettlementReceipt } from "@qorechain/rdk";
import { rdk, ROLLUP_ID } from "../config.js";

const file = (i: number) => `receipts/${ROLLUP_ID}-batch-${i}.json`;
type Saved = { receipt: SettlementReceipt; verification: { valid: boolean; mode: string; checks?: Record<string, unknown> }; savedAt?: string; creatorPublicKey?: string };

async function live(index: number) {
  const receipt = await buildSettlementReceipt(rdk, ROLLUP_ID, index);
  const v = await verifySettlementReceipt(receipt, { client: rdk });
  const creatorPublicKey = await rdk.rest.getPqcAccount(receipt.creator).then((a: { publicKey: string }) => a.publicKey).catch(() => undefined);
  console.log(`batch ${index} receipt: ${v.valid ? "VALID" : "NOT VALID"} (${v.mode})`);
  for (const [check, ok] of Object.entries(v.checks ?? {})) console.log(`  ${ok ? "✔" : "✖"} ${check}`);
  console.log(`  anchored at main-chain height ${v.anchor?.mainChainHeight}, ${v.anchor?.transactionCount} txs, signed by ${receipt.creator} (${receipt.algorithm})`);
  mkdirSync("receipts", { recursive: true });
  // Keep the first chain-verified copy: it is the evidence once the chain prunes the batch.
  const prev = existsSync(file(index)) ? (JSON.parse(readFileSync(file(index), "utf8")) as Saved) : undefined;
  if (v.valid || !prev?.verification.valid)
    writeFileSync(file(index), JSON.stringify({ receipt, verification: v, savedAt: new Date().toISOString(), creatorPublicKey }, null, 2));
  return v.valid;
}

async function saved(index: number) {
  if (!existsSync(file(index))) return undefined;
  const s = JSON.parse(readFileSync(file(index), "utf8")) as Saved;
  const key = s.creatorPublicKey ?? (await rdk.rest.getPqcAccount(s.receipt.creator)).publicKey;
  const v = await verifySettlementReceipt(s.receipt, { creatorPublicKey: key });
  const sigOk = v.mode === "signature-only" && v.checks.pqcSignature; // the other checks need the chain, by design
  console.log(`batch ${index}: pruned from the chain; using the saved receipt (${file(index)})`);
  console.log(`  ${sigOk ? "✔" : "✖"} ML-DSA-87 signature by ${s.receipt.creator} over the saved receipt`);
  console.log(`  ${s.verification.valid ? "✔" : "✖"} full chain verification when saved${s.savedAt ? ` (${s.savedAt})` : ""}: ${s.verification.mode}`);
  return sigOk && s.verification.valid;
}

const forceSaved = process.argv.includes("--saved"); // check the saved copy as if the chain had pruned the batch

async function one(index: number) {
  if (forceSaved) {
    const r = await saved(index);
    if (r === undefined) throw new Error(`no saved receipt for batch ${index}`);
    return r;
  }
  try {
    return await live(index);
  } catch (e) {
    const r = await saved(index);
    if (r === undefined) throw e;
    return r;
  }
}

async function main() {
  const arg = process.argv[2];
  if (arg === "all") {
    let bad = 0;
    for (let i = 0; ; i++) {
      try {
        if (!(await one(i))) bad++;
      } catch {
        console.log(`batch ${i}: none on chain and none saved; ${i} batches checked`);
        break;
      }
    }
    if (bad) process.exit(2);
    return;
  }
  const index = Number(arg);
  if (!Number.isInteger(index)) throw new Error("usage: receipt <batch index> | receipt all");
  if (!(await one(index))) process.exit(2);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
