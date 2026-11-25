/**
 * Audit every payout from the claims pool, independently of the watchtower:
 * rebuild its view from the chain batch by batch (starting from nothing), work
 * out which payouts were owed, and match each real pool withdrawal against them.
 * It reads the chain only and keeps no state between runs, so anyone with the
 * investigator's read key can run it and get the same answer.
 * Usage: audit   →   flights/local/audit.json (exported to the website)
 */
import { EMPTY_INBOX_ACC, fetchQledgerEntries, isRestNotFound, qledgerAccumulate } from "@qorechain/rdk";
import { auditBatch, type AuditState } from "../audit.js";
import { rdk, ROLLUP_ID, toQor } from "../config.js";
import { account, kemKey, poolKey } from "../keys.js";
import { save } from "../state.js";
import { hex } from "../util.js";
import { emptyState, judgeFlight } from "../watchtower.js";

const PAYOUT_UQOR = 5_000_000n;

const env = { chainId: rdk.network.chainId, rollupId: ROLLUP_ID };
const rollup = await rdk.rest.getRollup(ROLLUP_ID);
let latest = -1;
try {
  latest = (await rdk.rest.getLatestBatch(ROLLUP_ID)).batchIndex;
} catch (e) {
  if (!isRestNotFound(e)) throw e;
}
const read = { poolAccount: hex(poolKey().accountId), insurer: (await account("insurer")).address };
const member = { address: (await account("investigator")).address, decapsulationKey: kemKey("investigator").seed };
const st: AuditState = { watch: emptyState(), owed: [], rows: [] };

let accFrom: Uint8Array = EMPTY_INBOX_ACC;
for (let i = 0; i <= latest; i++) {
  const b = await rdk.rest.getBatch(ROLLUP_ID, i);
  if (b.status === "rejected") continue; // fraud upheld: its entries are re-settled by the batch that replaced it
  const entries = await fetchQledgerEntries(rdk.rest, { ...env, from: b.inboxStart, to: b.inboxEnd, accFrom });
  const now = Math.max(0, ...entries.map((e) => Number(e.height)));
  auditBatch(st, entries, i, { creator: rollup.creator, read, env, payoutUqor: PAYOUT_UQOR, now }, (f) => judgeFlight(st.watch, f, env, member)?.verdict);
  accFrom = qledgerAccumulate({ ...env, from: b.inboxStart, accFrom, entries });
}

for (const r of st.rows) console.log(`${r.justified ? "OK " : "BAD"} batch ${r.batch}: ${toQor(BigInt(r.amount))} QOR to ${r.recipient} (${r.reason})`);
for (const o of st.owed) console.log(`owed, not paid yet: ${toQor(BigInt(o.amount))} QOR to ${o.recipient} (${o.reason})`);
const bad = st.rows.filter((r) => !r.justified).length;
console.log(`${st.rows.length} pool payouts, ${st.rows.length - bad} justified, ${bad} NOT justified, ${st.owed.length} owed and not paid yet`);
save("audit", { checkedAt: new Date().toISOString(), batches: latest + 1, rows: st.rows, owed: st.owed });
