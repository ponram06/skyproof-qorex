/**
 * Write the investigator's demo key file for the website's investigator view
 * (keys/ is git-ignored). It holds the ML-KEM-1024 seed that opens sealed
 * flight records, so treat it like any secret: load it in the page, never share it.
 * Usage: investigator-key  →  keys/investigator.json
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { account, kemKey } from "../keys.js";
import { hex } from "../util.js";

const k = kemKey("investigator");
mkdirSync("keys", { recursive: true });
writeFileSync(
  "keys/investigator.json",
  JSON.stringify({ role: "investigator", address: (await account("investigator")).address, mlkem1024Seed: hex(k.seed), publicKeyFingerprint: hex(k.publicKey).slice(0, 16) }, null, 2),
);
console.log("wrote rollup/keys/investigator.json (git-ignored). Load it in the website's Investigator view.");
