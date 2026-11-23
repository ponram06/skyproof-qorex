import { sha256 } from "@noble/hashes/sha2";

export const enc = new TextEncoder();
export const dec = new TextDecoder();

// No Node Buffer here: these helpers also run in the browser (web/).
export const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
export const unhex = (s: string): Uint8Array => {
  const h = s.replace(/^0x/, "");
  if (h.length % 2 || /[^0-9a-f]/i.test(h)) throw new Error("not hex");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(2 * i, 2 * i + 2), 16);
  return out;
};

export const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

export const u32 = (n: number): Uint8Array => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n);
  return b;
};
export const readU32 = (b: Uint8Array, at: number): number => new DataView(b.buffer, b.byteOffset).getUint32(at);

/** JSON with sorted keys, so the same value always hashes the same. */
export const canonical = (v: unknown): string => {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
    .join(",")}}`;
};

/** SHA-256 over a domain tag and parts, so hashes for different uses never collide. */
export const tagged = (tag: string, ...parts: Uint8Array[]): Uint8Array => sha256(concat(enc.encode(tag), new Uint8Array([0]), ...parts));

export { sha256 };

export const equalBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i]);
