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
import { createRdkRegistry, depositToRollupMsg, postRollupDataMsg, resolvePqcKeypair, type RdkClient } from "@qorechain/rdk";
import type { EncodeObject } from "@cosmjs/proto-signing";
import { buildHybridTx, deriveNativeAccount, directSignerFromPrivateKey, generateMnemonic, validateMnemonic, type PqcKeypair } from "@qorechain/sdk";
import { claimPost, decisionPost, type Claim, type Decision } from "../../rollup/src/flight/posts";

const STORE = "skyproof.claimWallet.v1";
const REST = `${location.origin}/api/rest`;
const GAS_PRICE = 0.15; // uqor per gas, the SDK default
/** What filing costs, with headroom for the fee: the 1 QOR refundable deposit + about 0.05 QOR fee. */
export const CLAIM_FUNDS_QOR = 1.1;

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

/** Everything needed to sign a hybrid transaction for one account. */
export interface SigningKeys {
  address: string;
  privateKey: Uint8Array;
  pqc: PqcKeypair;
  /** True until the chain holds this ML-DSA-87 key: the next tx then registers it. */
  includePqcPublicKey: boolean;
}

async function walletKeys(client: RdkClient, w: ClaimWallet): Promise<SigningKeys> {
  const acct = await deriveNativeAccount(w.mnemonic);
  const pqc = await resolvePqcKeypair(client, acct.address, w.mnemonic);
  return { address: acct.address, privateKey: acct.privateKey, pqc: pqc.keypair, includePqcPublicKey: pqc.includePqcPublicKey };
}

/** Keys from the insurer key file written by `npm run insurer-key` in rollup/. */
export function keysFromFile(k: { address: string; secp256k1PrivateKey: string; mldsa87: { publicKey: string; secretKey: string; registered: boolean } }): SigningKeys {
  const bytes = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
  return { address: k.address, privateKey: bytes(k.secp256k1PrivateKey), pqc: { publicKey: bytes(k.mldsa87.publicKey), secretKey: bytes(k.mldsa87.secretKey) }, includePqcPublicKey: !k.mldsa87.registered };
}

export interface Sent {
  txhash: string;
  height: number;
  feeUqor: bigint;
}

/**
 * Sign `messages` hybrid (secp256k1 + ML-DSA-87), simulate for the fee, check the
 * balance covers fee + `alsoSpendUqor`, broadcast, and wait for inclusion.
 */
export async function sendHybrid(
  client: RdkClient,
  keys: SigningKeys,
  messages: EncodeObject[],
  opts: { alsoSpendUqor?: bigint; what: string; progress?: (step: string) => void },
): Promise<Sent> {
  const progress = opts.progress ?? (() => undefined);
  progress("Preparing your quantum-safe signature…");
  const signer = await directSignerFromPrivateKey(keys.privateKey, "qor");
  const info = await restJson<{ account?: { account_number: string; sequence: string }; message?: string }>(`/cosmos/auth/v1beta1/accounts/${keys.address}`);
  if (!info.ok || !info.json.account) throw new Error("This wallet has no QOR yet. Add test QOR to it first.");
  const { account_number, sequence } = info.json.account;

  const registry = createRdkRegistry();
  const build = (gas: number) =>
    buildHybridTx({
      registry,
      signer,
      pqcKeypair: keys.pqc,
      includePqcPublicKey: keys.includePqcPublicKey,
      messages,
      fee: { amount: [{ denom: "uqor", amount: String(Math.ceil(gas * GAS_PRICE)) }], gas: String(gas) },
      chainId: client.network.chainId,
      accountNumber: BigInt(account_number),
      sequence: BigInt(sequence),
      rest: REST,
    });

  progress("Estimating the fee…");
  const sim = await restJson<{ gas_info?: { gas_used: string }; message?: string }>("/cosmos/tx/v1beta1/simulate", { tx_bytes: b64((await build(1_000_000)).txRawBytes) });
  if (!sim.ok || !sim.json.gas_info) throw new Error(`QoreChain refused the ${opts.what}: ${sim.json.message ?? `HTTP ${sim.status}`}`);
  const gas = Math.ceil(Number(sim.json.gas_info.gas_used) * 1.3) + 5_000;
  const feeUqor = BigInt(Math.ceil(gas * GAS_PRICE));
  const need = feeUqor + (opts.alsoSpendUqor ?? 0n);
  if ((await balanceUqor(keys.address)) < need) throw new Error(`Not enough QOR: ${Number(need) / 1e6} QOR needed (fee${opts.alsoSpendUqor ? " + deposit" : ""}).`);

  progress("Signing and sending…");
  const sent = await restJson<{ tx_response?: { txhash: string; code: number; raw_log?: string }; message?: string }>("/cosmos/tx/v1beta1/txs", {
    tx_bytes: b64((await build(gas)).txRawBytes),
    mode: "BROADCAST_MODE_SYNC",
  });
  const res = sent.json.tx_response;
  if (!sent.ok || !res) throw new Error(`Couldn't send: ${sent.json.message ?? `HTTP ${sent.status}`}`);
  if (res.code) throw new Error(`QoreChain refused the ${opts.what} (code ${res.code}): ${res.raw_log ?? ""}`);

  progress("Waiting for QoreChain to confirm…");
  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    const t = await restJson<{ tx_response?: { code: number; height: string; raw_log?: string } }>(`/cosmos/tx/v1beta1/txs/${res.txhash}`);
    const r = t.json.tx_response;
    if (!t.ok || !r) continue;
    if (r.code) throw new Error(`The ${opts.what} failed on chain (code ${r.code}): ${r.raw_log ?? ""}`);
    return { txhash: res.txhash, height: Number(r.height), feeUqor };
  }
  throw new Error(`Sent (${res.txhash}), but not confirmed yet. Check again in a minute.`);
}

/** SHA-256 (hex) of a file, computed in the browser. The file itself is never uploaded. */
export async function fileFingerprint(f: File): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", await f.arrayBuffer()));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * File a claim: in ONE transaction, deposit `depositUqor` into the claims pool
 * (refunded with the payout) and post the claim (SKYC1). The poster address is
 * the address that gets paid. If either part fails, neither happens.
 */
export async function fileClaim(
  client: RdkClient,
  w: ClaimWallet,
  c: { rollupId: string; poolAccount: string; depositUqor: bigint; claim: Claim },
  progress?: (step: string) => void,
): Promise<Sent> {
  const keys = await walletKeys(client, w);
  return sendHybrid(
    client,
    keys,
    [
      depositToRollupMsg({ depositor: keys.address, rollupId: c.rollupId, account: c.poolAccount, amount: c.depositUqor }),
      postRollupDataMsg({ poster: keys.address, rollupId: c.rollupId, data: claimPost(c.claim) }),
    ],
    { alsoSpendUqor: c.depositUqor, what: "claim", progress },
  );
}

/** The insurer's decision on a claim in review (SKYI1). */
export function postDecision(client: RdkClient, keys: SigningKeys, rollupId: string, d: Decision, progress?: (step: string) => void): Promise<Sent> {
  return sendHybrid(client, keys, [postRollupDataMsg({ poster: keys.address, rollupId, data: decisionPost(d) })], { what: "decision", progress });
}
