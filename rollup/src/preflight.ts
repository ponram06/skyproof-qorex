/**
 * Preflight: read the live rdk parameters, work out what creating SkyProof's
 * rollup costs, and (if an operator mnemonic is set) check that wallet's
 * balance and ML-DSA-87 key. Read-only: it never signs or broadcasts.
 */
import { deriveNativeAccount, isValidRollupId, isRestNotFound, pqcKeypairFromEnv } from "@qorechain/rdk";
import { rdk, ROLLUP_ID, toQor } from "./config.js";

const LAYER_STAKE_UQOR = 1_000_000_000n; // min_sidechain_stake (1,000 QOR), returned on stop
const FEES_BUFFER_UQOR = 150_000_000n; // fees, posted data, demo bond deposit

async function main() {
  const net = rdk.network;
  console.log(`network   ${net.chainId}`);

  const tip = await rdk.getChainTip();
  console.log(`chain tip ${tip.height}`);

  const p = await rdk.params();
  const stake = BigInt(p.minStakeForRollup);
  const burn = (stake * BigInt(Math.round(Number(p.rollupCreationBurnRate) * 10_000))) / 10_000n;
  const bond = BigInt(p.minSubmitterBond ?? "1000000000");
  const total = stake + LAYER_STAKE_UQOR + bond + FEES_BUFFER_UQOR;

  console.log("\nrollup costs (live params)");
  console.log(`  stake           ${toQor(stake)} QOR (burned on create: ${toQor(burn)})`);
  console.log(`  layer stake     ${toQor(LAYER_STAKE_UQOR)} QOR`);
  console.log(`  submitter bond  ${toQor(bond)} QOR`);
  console.log(`  fees + demo     ${toQor(FEES_BUFFER_UQOR)} QOR`);
  console.log(`  needed          ${toQor(total)} QOR`);
  console.log(`  challenge window ${p.defaultChallengeWindow}s`);

  if (!isValidRollupId(ROLLUP_ID)) throw new Error(`invalid rollup id: ${ROLLUP_ID}`);
  try {
    const r = await rdk.rest.getRollup(ROLLUP_ID);
    console.log(`\nrollup ${ROLLUP_ID}: exists (${r.status}, creator ${r.creator})`);
  } catch (e) {
    if (!isRestNotFound(e)) throw e;
    console.log(`\nrollup ${ROLLUP_ID}: free to create`);
  }

  const mnemonic = process.env.QORE_MNEMONIC?.trim();
  if (!mnemonic) {
    console.log("\nno QORE_MNEMONIC set: skipping wallet checks");
    return;
  }
  const account = await deriveNativeAccount(mnemonic);
  const balance = BigInt(await rdk.rest.getBalance(account.address));
  console.log(`\noperator  ${account.address}`);
  console.log(`  balance ${toQor(balance)} QOR ${balance >= total ? "(enough)" : `(short by ${toQor(total - balance)})`}`);

  const pqc = await pqcKeypairFromEnv(rdk, account.address);
  console.log(`  ML-DSA-87 key ${pqc?.registered ? `registered (${pqc.derivation})` : "not registered yet: the first hybrid tx registers it"}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
