/**
 * One-time setup for every role account:
 *  - fund the role accounts from the operator (small amounts for fees);
 *  - register each account's ML-DSA-87 key with proof of possession;
 *  - register the investigator's and insurer's ML-KEM-1024 keys, so flight
 *    records can be sealed to them.
 */
import { ensurePqcRegistered } from "@qorechain/sdk";
import { connect, txLine } from "../chain.js";
import { rdk, toQor } from "../config.js";
import { kemKey, type Role } from "../keys.js";
import { hex } from "../util.js";

const FUND: Partial<Record<Role, bigint>> = { investigator: 2_000_000n, insurer: 2_000_000n, judge: 5_000_000n, victim: 2_000_000n };

async function main() {
  const op = await connect("operator");
  console.log(`operator ${op.address} (${toQor(await rdk.rest.getBalance(op.address))} QOR)`);

  for (const role of Object.keys(FUND) as Role[]) {
    const c = await connect(role);
    const bal = BigInt(await rdk.rest.getBalance(c.address));
    console.log(`\n${role} ${c.address} (${toQor(bal)} QOR)`);
    const want = FUND[role]!;
    if (bal < want / 2n) {
      const r = await op.tx.bankSend(c.address, [{ denom: "uqor", amount: (want - bal).toString() }], { fee: "auto" });
      txLine(`funded ${toQor(want - bal)} QOR`, r);
    }
  }

  for (const role of ["operator", ...Object.keys(FUND)] as Role[]) {
    const c = await connect(role);
    if (c.pqcRegistered) continue;
    const r = await ensurePqcRegistered(c.tx, { pqcKeypair: c.pqcKeypair, rest: rdk.network.endpoints.rest });
    console.log(`  ${role}: ML-DSA-87 key ${r.alreadyRegistered ? "already registered" : `registered, tx ${r.txHash}`}`);
  }

  for (const role of ["investigator", "insurer"] as const) {
    const c = await connect(role);
    const k = kemKey(role);
    const onChain = await rdk.rest.getKemKey(c.address);
    if (onChain && onChain.publicKey.toLowerCase().replace(/^0x/, "") === hex(k.publicKey)) {
      console.log(`  ${role}: ML-KEM-1024 key already registered`);
      continue;
    }
    txLine(`${role}: ML-KEM-1024 key registered`, await c.rdkTx.registerKemKey({ publicKey: k.publicKey }, { fee: "auto" }));
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
