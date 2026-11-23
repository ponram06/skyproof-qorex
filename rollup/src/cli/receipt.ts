/**
 * Build the settlement receipt for a batch and verify it against live chain
 * state: the batch is anchored on QoreChain under the rollup creator's
 * ML-DSA-87 signature. Saved to receipts/ as evidence. Usage: receipt <batch>
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { buildSettlementReceipt, verifySettlementReceipt } from "@qorechain/rdk";
import { rdk, ROLLUP_ID } from "../config.js";

async function main() {
  const index = Number(process.argv[2]);
  if (!Number.isInteger(index)) throw new Error("usage: receipt <batch index>");
  const receipt = await buildSettlementReceipt(rdk, ROLLUP_ID, index);
  const v = await verifySettlementReceipt(receipt, { client: rdk });
  console.log(`batch ${index} receipt: ${v.valid ? "VALID" : "NOT VALID"} (${v.mode})`);
  console.log(JSON.stringify(v, null, 2));
  mkdirSync("receipts", { recursive: true });
  writeFileSync(`receipts/${ROLLUP_ID}-batch-${index}.json`, JSON.stringify({ receipt, verification: v }, null, 2));
  if (!v.valid) process.exit(2);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
