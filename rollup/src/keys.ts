/**
 * Every key SkyProof uses, derived from one demo mnemonic (QORE_MNEMONIC).
 *
 * On-chain accounts are HD accounts of that mnemonic, one per role. Off-chain
 * keys (the drone's ML-DSA-87 key, the ML-KEM-1024 keys that open sealed
 * records, the claims pool's ML-DSA-44 ledger key) come from domain-tagged
 * hashes of it, so nothing else needs to be stored.
 *
 * One mnemonic for every role keeps the demo runnable by one person. In a real
 * deployment each role holds its own secret: see docs/THREAT_MODEL.md.
 */
import "dotenv/config";
import { kemKeypairFromSeed, qledgerKeypairFromSeed } from "@qorechain/rdk";
import { deriveNativeAccount, generatePqcKeypair } from "@qorechain/sdk";
import { enc, tagged } from "./util.js";

/** `rogue` is the dishonest second submitter of the fraud demo (cli/fraud-demo.ts). */
export type Role = "operator" | "investigator" | "insurer" | "judge" | "victim" | "rogue";
export const ROLE_INDEX: Record<Role, number> = { operator: 0, investigator: 1, insurer: 2, judge: 3, victim: 4, rogue: 5 };

export function mnemonic(): string {
  const m = process.env.QORE_MNEMONIC?.trim();
  if (!m) throw new Error("set QORE_MNEMONIC in rollup/.env (see .env.example)");
  return m;
}

const seedFor = (name: string, len: 32 | 64): Uint8Array => {
  const a = tagged(`skyproof/key/${name}`, enc.encode(mnemonic()));
  return len === 32 ? a : new Uint8Array([...a, ...tagged(`skyproof/key/${name}/2`, enc.encode(mnemonic()))]);
};

export const account = (role: Role) => deriveNativeAccount(mnemonic(), { accountIndex: ROLE_INDEX[role] });

/** The drone's record-signing key (ML-DSA-87). */
export const droneKey = (droneId: string) => generatePqcKeypair(seedFor(`drone/${droneId}`, 32));

/** The ML-KEM-1024 key a recipient opens sealed flight records with. */
export function kemKey(role: "investigator" | "insurer") {
  const seed = seedFor(`kem/${role}`, 64);
  return { seed, ...kemKeypairFromSeed(seed) };
}

/** The claims pool's qledger-v1 account (ML-DSA-44), held by the judge. */
export const poolKey = () => qledgerKeypairFromSeed(seedFor("pool", 32));
