/**
 * Investigator view: open sealed flight records in the browser with the
 * investigator's ML-KEM-1024 key, check them against the drone-signed headers,
 * judge them with the same rules code as the watchtower, and draw the flight.
 * The key never leaves the page.
 */
import { openEnvelope } from "@qorechain/rdk";
import { sha256 } from "@noble/hashes/sha2";
import { judge, type Permit, type Verdict } from "../../rollup/src/rules";
import { canonical, hex, parseHeaderPost, unhex, type SegmentHeader } from "./verify";

type Rec = { seq: number; t: number; k: string; lat?: number; lon?: number; alt?: number; wind?: number; act?: string; ok?: boolean; req?: string };

export interface InvestigatorData {
  chainId: string;
  rollup: { rollupId: string };
  drones: Record<string, { permit: Permit }>;
  headers: { post: string }[];
  bodies: Record<string, string>;
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const recordHash = (prev: Uint8Array, rec: Rec) => {
  const tag = enc.encode("skyproof/record/v1");
  const body = enc.encode(canonical(rec));
  const buf = new Uint8Array(tag.length + 1 + prev.length + body.length);
  buf.set(tag);
  buf.set(prev, tag.length + 1);
  buf.set(body, tag.length + 1 + prev.length);
  return sha256(buf);
};

export function openFlight(d: InvestigatorData, flight: string, key: { address: string; seed: string }) {
  const segs = d.headers.map((h) => parseHeaderPost(h.post).header).filter((h) => h.flight === flight).sort((a, b) => a.idx - b.idx);
  const errors: string[] = [];
  const recs: Rec[] = [];
  let prev = "00".repeat(32);
  for (const h of segs as SegmentHeader[]) {
    if (h.prev !== prev) errors.push(`segment ${h.idx} does not continue the previous one`);
    prev = h.head;
    const body = d.bodies[h.body];
    if (!body) {
      errors.push(`segment ${h.idx} body withheld`);
      continue;
    }
    if (hex(sha256(unhex(body))) !== h.body) errors.push(`segment ${h.idx} body does not match its signed header`);
    const plain = openEnvelope({ envelope: unhex(body).subarray(5), chainId: d.chainId, rollupId: d.rollup.rollupId, member: key.address, decapsulationKey: unhex(key.seed) });
    const seg = JSON.parse(dec.decode(plain)) as { recs: Rec[] };
    const head = hex(seg.recs.reduce((p, r) => recordHash(p, r), unhex(h.prev)));
    if (head !== h.head) errors.push(`segment ${h.idx}: records do not hash to the signed head`);
    recs.push(...seg.recs);
  }
  const permit = d.drones[segs[0]?.drone]?.permit;
  const verdict: Verdict = permit ? judge(recs as never, permit, errors) : { breach: false, findings: [] };
  return { recs, verdict, permit, segments: segs.length, errors };
}

/** An SVG map of the flight in local metres around the permit's centre. */
export function drawFlight(recs: Rec[], permit: Permit, verdict: Verdict): string {
  const c = permit.area;
  const k = 111_320;
  const xy = (lat: number, lon: number) => [(lon - c.lon) * k * Math.cos((c.lat * Math.PI) / 180), (lat - c.lat) * k] as const;
  const R = c.r * 1.08;
  const S = 360 / R; // px per metre
  const px = (x: number, y: number) => `${(x * S + 380).toFixed(1)},${(-y * S + 380).toFixed(1)}`;
  const samples = recs.filter((r) => r.k === "SAMPLE" && r.lat !== undefined);
  const pts = samples.map((r) => xy(r.lat!, r.lon!));
  const bad = new Set(verdict.findings.map((f) => f.seq).filter((s) => s !== undefined));
  const posAt = (seq: number) => {
    const s = [...samples].reverse().find((r) => r.seq <= seq) ?? samples[0];
    return xy(s.lat!, s.lon!);
  };

  const marks = recs
    .filter((r) => r.k === "ACTION" || (r.k === "DECISION" && !r.ok) || bad.has(r.seq))
    .map((r) => {
      const [x, y] = r.k === "SAMPLE" ? xy(r.lat!, r.lon!) : posAt(r.seq);
      const isBad = bad.has(r.seq);
      const color = isBad ? "var(--bad)" : r.k === "DECISION" ? "var(--warn)" : "var(--ok)";
      const label = r.k === "ACTION" ? r.act : r.k === "DECISION" ? `DENY ${r.act}` : `${r.alt} m`;
      return `<g><circle cx="${px(x, y).split(",")[0]}" cy="${px(x, y).split(",")[1]}" r="${isBad ? 7 : 5}" fill="${color}"><title>#${r.seq} ${label}</title></circle></g>`;
    });

  const circle = (lat: number, lon: number, r: number, cls: string) => {
    const [x, y] = xy(lat, lon);
    const [cx, cy] = px(x, y).split(",");
    return `<circle cx="${cx}" cy="${cy}" r="${(r * S).toFixed(1)}" class="${cls}"/>`;
  };
  return `<svg viewBox="0 0 760 760" class="map" role="img" aria-label="Flight path">
    ${circle(c.lat, c.lon, c.r, "area")}
    ${permit.noFly.map((z) => circle(z.lat, z.lon, z.r, "nofly")).join("")}
    <polyline points="${pts.map(([x, y]) => px(x, y)).join(" ")}" class="path"/>
    ${marks.join("")}
  </svg>`;
}
