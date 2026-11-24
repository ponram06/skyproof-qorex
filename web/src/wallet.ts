/**
 * A quantum-safe claim wallet that lives in this browser.
 *
 * QoreChain testnet refuses classical-only transactions (hybrid signatures are
 * required), so a browser wallet like Keplr cannot sign a claim on its own.
 * Instead the page creates a QoreChain account from a fresh recovery phrase:
 * a secp256k1 key plus its canonical ML-DSA-87 key. The first transaction
 * carries the ML-DSA-87 public key, which registers it on chain.
 *
 * The phrase stays in this browser (localStorage) and is shown to the user so
 * they can keep it. Transactions go through the site's proxy (/api/rest),
 * because the testnet API sends no CORS headers.
 */
import { createRdkRegistry, postRollupDataMsg, resolvePqcKeypair, type RdkClient } from "@qorechain/rdk";
import { buildHybridTx, deriveNativeAccount, directSignerFromPrivateKey, generateMnemonic, validateMnemonic } from "@qorechain/sdk";
import { claimPost } from "../../rollup/src/flight/posts";

const STORE = "skyproof.claimWallet.v1";
const REST = `${location.origin}/api/rest`;
const GAS_PRICE = 0.15; // uqor per gas, the SDK default
/** What a claim costs in fees, with headroom: shown to the user before they fund the wallet. */
export const CLAIM_FEE_QOR = 0.1;

export interface ClaimWallet {
  mnemonic: string;
  address: string;
}

const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));

async function restJson<T>(path: string, body?: unknown): Promise<{ ok: boolean; status: number; json: T }> {
  const r = await fetch(REST + path, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : undefined);
  const text = await r.text();
  let json: T;
  try {
    json = JSON.parse(text) as T;
  } catch {
    json = { message: text } as T;
  }
  return { ok: r.ok, status: r.status, json };
}

export function loadWallet(): ClaimWallet | undefined {
  try {
    const w = JSON.parse(localStorage.getItem(STORE) ?? "null") as ClaimWallet | null;
    return w && validateMnemonic(w.mnemonic) ? w : undefined;
  } catch {
    return undefined;
  }
}

function saveWallet(w: ClaimWallet) {
  try {
    localStorage.setItem(STORE, JSON.stringify(w));
  } catch {
    /* private mode: the wallet still works for this visit */
  }
}

export function forgetWallet() {
  try {
    localStorage.removeItem(STORE);
  } catch {
    /* nothing stored */
  }
}

async function fromMnemonic(mnemonic: string): Promise<ClaimWallet> {
  const m = mnemonic.trim().toLowerCase().split(/\s+/).join(" ");
  if (!validateMnemonic(m)) throw new Error("Those words aren't a valid recovery phrase.");
  const acct = await deriveNativeAccount(m);
  return { mnemonic: m, address: acct.address };
}

export async function createWallet(): Promise<ClaimWallet> {
  const w = await fromMnemonic(generateMnemonic(256));
  saveWallet(w);
  return w;
}

export async function restoreWallet(mnemonic: string): Promise<ClaimWallet> {
  const w = await fromMnemonic(mnemonic);
  saveWallet(w);
  return w;
}

/** Spendable QOR (uqor) of an address; 0 when the account doesn't exist yet. */
export async function balanceUqor(address: string): Promise<bigint> {
  const r = await restJson<{ balances?: { denom: string; amount: string }[] }>(`/cosmos/bank/v1beta1/balances/${address}`);
  return BigInt(r.json.balances?.find((b) => b.denom === "uqor")?.amount ?? "0");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Post a claim (SKYC1) for `flight` to the SkyProof rollup, signed hybrid
 * (secp256k1 + ML-DSA-87). The poster address is the address that gets paid.
 */
export async function fileClaim(
  client: RdkClient,
  w: ClaimWallet,
  claim: { rollupId: string; flight: string; note: string },
  progress: (step: string) => void = () => undefined,
): Promise<{ txhash: string; height: number; feeUqor: bigint }> {
  progress("Preparing your quantum-safe signature…");
  const acct = await deriveNativeAccount(w.mnemonic);
  const signer = await directSignerFromPrivateKey(acct.privateKey, "qor");
  const pqc = await resolvePqcKeypair(client, acct.address, w.mnemonic);

  const info = await restJson<{ account?: { account_number: string; sequence: string }; message?: string }>(`/cosmos/auth/v1beta1/accounts/${acct.address}`);
  if (!info.ok || !info.json.account) throw new Error("This wallet has no QOR yet. Add a little test QOR to it first.");
  const { account_number, sequence } = info.json.account;

  const registry = createRdkRegistry();
  const messages = [postRollupDataMsg({ poster: acct.address, rollupId: claim.rollupId, data: claimPost({ flight: claim.flight, note: claim.note }) })];
  const build = (gas: number) =>
    buildHybridTx({
      registry,
      signer,
      pqcKeypair: pqc.keypair,
      includePqcPublicKey: pqc.includePqcPublicKey,
      messages,
      fee: { amount: [{ denom: "uqor", amount: String(Math.ceil(gas * GAS_PRICE)) }], gas: String(gas) },
      chainId: client.network.chainId,
      accountNumber: BigInt(account_number),
      sequence: BigInt(sequence),
      rest: REST,
    });

  progress("Estimating the fee…");
  const sim = await restJson<{ gas_info?: { gas_used: string }; message?: string }>("/cosmos/tx/v1beta1/simulate", { tx_bytes: b64((await build(1_000_000)).txRawBytes) });
  if (!sim.ok || !sim.json.gas_info) throw new Error(`QoreChain refused the claim: ${sim.json.message ?? `HTTP ${sim.status}`}`);
  const gas = Math.ceil(Number(sim.json.gas_info.gas_used) * 1.3) + 5_000;
  const feeUqor = BigInt(Math.ceil(gas * GAS_PRICE));
  if ((await balanceUqor(acct.address)) < feeUqor) throw new Error(`Not enough QOR for the fee (${Number(feeUqor) / 1e6} QOR needed).`);

  progress("Signing and sending…");
  const sent = await restJson<{ tx_response?: { txhash: string; code: number; raw_log?: string }; message?: string }>("/cosmos/tx/v1beta1/txs", {
    tx_bytes: b64((await build(gas)).txRawBytes),
    mode: "BROADCAST_MODE_SYNC",
  });
  const res = sent.json.tx_response;
  if (!sent.ok || !res) throw new Error(`Couldn't send: ${sent.json.message ?? `HTTP ${sent.status}`}`);
  if (res.code) throw new Error(`QoreChain refused the claim (code ${res.code}): ${res.raw_log ?? ""}`);

  progress("Waiting for QoreChain to confirm…");
  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    const t = await restJson<{ tx_response?: { code: number; height: string; raw_log?: string } }>(`/cosmos/tx/v1beta1/txs/${res.txhash}`);
    const r = t.json.tx_response;
    if (!t.ok || !r) continue;
    if (r.code) throw new Error(`The claim failed on chain (code ${r.code}): ${r.raw_log ?? ""}`);
    return { txhash: res.txhash, height: Number(r.height), feeUqor };
  }
  throw new Error(`Sent (${res.txhash}), but not confirmed yet. Check again in a minute.`);
}
