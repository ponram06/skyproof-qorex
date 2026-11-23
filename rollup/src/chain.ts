/** Hybrid-signing clients (secp256k1 + ML-DSA-87) for each role's account. */
import { GasPrice } from "@cosmjs/stargate";
import { resolvePqcKeypair, type PqcKeypair, type RdkTxClient } from "@qorechain/rdk";
import { directSignerFromPrivateKey, TxClient } from "@qorechain/sdk";
import { rdk } from "./config.js";
import { account, mnemonic, type Role } from "./keys.js";

export const GAS_PRICE = "0.15uqor";

export interface RoleClient {
  role: Role;
  address: string;
  /** rdk module messages (rollups, batches, posts, withdrawals, KEM keys). */
  rdkTx: RdkTxClient;
  /** Everything else (bank sends). */
  tx: TxClient;
  pqcKeypair: PqcKeypair;
  pqcRegistered: boolean;
}

export async function connect(role: Role): Promise<RoleClient> {
  const acct = await account(role);
  const signer = await directSignerFromPrivateKey(acct.privateKey, "qor");
  const pqc = await resolvePqcKeypair(rdk, acct.address, mnemonic());
  const rdkTx = await rdk.connectTx(signer, {
    gasPrice: GAS_PRICE,
    pqcKeypair: pqc.keypair,
    includePqcPublicKey: pqc.includePqcPublicKey,
  });
  const tx = await TxClient.connect({
    rpcEndpoint: rdk.network.endpoints.rpc,
    signer,
    pqcKeypair: pqc.keypair,
    clientOptions: { gasPrice: GasPrice.fromString(GAS_PRICE) },
  });
  return { role, address: acct.address, rdkTx, tx, pqcKeypair: pqc.keypair, pqcRegistered: pqc.registered };
}

/** A short, safe summary of a broadcast result. */
export function txLine(label: string, r: { transactionHash?: string; txhash?: string; code?: number; height?: number }) {
  const hash = r.transactionHash ?? r.txhash ?? "?";
  if (r.code) throw new Error(`${label} failed (code ${r.code}): ${hash}`);
  console.log(`  ${label}: ${hash}${r.height ? ` (height ${r.height})` : ""}`);
  return hash;
}
