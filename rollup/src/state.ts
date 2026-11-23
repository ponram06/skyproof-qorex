/** Small JSON state files kept by the operator and the watchtower (git-ignored). */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { QledgerLedger } from "@qorechain/rdk";
import { hex, unhex } from "./util.js";

const DIR = resolve(process.cwd(), "flights/local");

export function load<T>(name: string, fallback: T): T {
  const p = resolve(DIR, `${name}.json`);
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as T) : fallback;
}

export function save(name: string, value: unknown) {
  const p = resolve(DIR, `${name}.json`);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
}

export interface SavedAccount {
  id: string;
  balance: string;
  nonce: string;
}
export const saveLedger = (l: QledgerLedger): SavedAccount[] =>
  l.accounts().map((a) => ({ id: hex(a.id), balance: a.balance.toString(), nonce: a.nonce.toString() }));
export function loadLedger(s: SavedAccount[] | undefined): QledgerLedger {
  const l = new QledgerLedger();
  for (const a of s ?? []) l.set(unhex(a.id), BigInt(a.balance), BigInt(a.nonce));
  return l;
}
