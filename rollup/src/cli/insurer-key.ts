/**
 * Write the insurer's demo key file for the website's insurer desk
 * (keys/ is git-ignored). It holds:
 *  - the insurer account's secp256k1 key and its registered ML-DSA-87 key, to
 *    sign decisions (QoreChain requires hybrid signatures);
 *  - the insurer's ML-KEM-1024 seed, to open sealed flight records.
 * Only the insurer's own keys go in the file, never the mnemonic. Treat it like
 * any secret: load it in the page, never share it.
 * Usage: insurer-key  →  keys/insurer.json
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolvePqcKeypair } from "@qorechain/rdk";
import { rdk } from "../config.js";
import { account, kemKey, mnemonic } from "../keys.js";
import { hex } from "../util.js";

const acct = await account("insurer");
const pqc = await resolvePqcKeypair(rdk, acct.address, mnemonic());
mkdirSync("keys", { recursive: true });
writeFileSync(
  "keys/insurer.json",
  JSON.stringify(
    {
      role: "insurer",
      address: acct.address,
      secp256k1PrivateKey: hex(acct.privateKey),
      mldsa87: { publicKey: hex(pqc.keypair.publicKey), secretKey: hex(pqc.keypair.secretKey), registered: pqc.registered },
      mlkem1024Seed: hex(kemKey("insurer").seed),
    },
    null,
    2,
  ),
);
console.log(`wrote rollup/keys/insurer.json for ${acct.address} (git-ignored). Load it in the website's insurer desk.`);
