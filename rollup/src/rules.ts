/**
 * The six safety rules a judge applies to an opened flight record.
 * Pure functions: the same record and permit always give the same verdict,
 * so anyone holding the record can re-run the judgement.
 */
import type { Action, FlightRecord } from "./flight/record.js";

export interface Circle {
  lat: number;
  lon: number;
  /** Radius in metres. */
  r: number;
}
export interface Permit {
  /** Where the drone may fly. */
  area: Circle;
  noFly: Circle[];
  maxAltM: number;
  maxWindMs: number;
  /** How long a safety approval stays valid. */
  approvalTtlMs: number;
  /** Actions that need a fresh ALLOW. */
  gated: Action[];
}

export type RuleCode = "B1_GEOFENCE" | "B2_ALTITUDE" | "B3_UNAPPROVED_ACTION" | "B4_OVERRIDE" | "B5_RECORD_BROKEN" | "B6_WIND";
export interface Finding {
  rule: RuleCode;
  seq?: number;
  detail: string;
}
export interface Verdict {
  breach: boolean;
  findings: Finding[];
}

const EARTH_R = 6_371_000;
/** Great-circle distance in metres. */
export function distanceM(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.sqrt(s));
}

/**
 * @param integrityErrors problems found while opening the record (bad
 *   signature, broken chain, missing segment, missing CLOSE, withheld body).
 *   Any of them is a B5 breach: a record the operator cannot produce intact
 *   counts against the operator.
 */
export function judge(recs: FlightRecord[], permit: Permit, integrityErrors: string[] = []): Verdict {
  const f: Finding[] = integrityErrors.map((detail) => ({ rule: "B5_RECORD_BROKEN", detail }));
  if (!recs.some((r) => r.k === "CLOSE")) f.push({ rule: "B5_RECORD_BROKEN", detail: "flight has no CLOSE record" });

  let lastWind = 0;
  const decisions = new Map<string, { ok: boolean; t: number; act: Action; used: boolean }>();

  for (const r of recs) {
    switch (r.k) {
      case "SAMPLE": {
        lastWind = r.wind;
        if (distanceM(r, permit.area) > permit.area.r)
          f.push({ rule: "B1_GEOFENCE", seq: r.seq, detail: `outside the permitted area (${Math.round(distanceM(r, permit.area))} m from centre)` });
        for (const z of permit.noFly)
          if (distanceM(r, z) <= z.r) f.push({ rule: "B1_GEOFENCE", seq: r.seq, detail: "inside a no-fly zone" });
        if (r.alt > permit.maxAltM) f.push({ rule: "B2_ALTITUDE", seq: r.seq, detail: `${r.alt} m above the ${permit.maxAltM} m ceiling` });
        break;
      }
      case "DECISION":
        decisions.set(r.req, { ok: r.ok, t: r.t, act: r.act, used: false });
        break;
      case "ACTION": {
        if (r.act === "TAKEOFF" && lastWind > permit.maxWindMs)
          f.push({ rule: "B6_WIND", seq: r.seq, detail: `took off in ${lastWind} m/s wind (limit ${permit.maxWindMs})` });
        if (!permit.gated.includes(r.act)) break;
        const d = decisions.get(r.req);
        if (!d) f.push({ rule: "B3_UNAPPROVED_ACTION", seq: r.seq, detail: `${r.act} with no safety decision` });
        else if (!d.ok) f.push({ rule: "B4_OVERRIDE", seq: r.seq, detail: `${r.act} after the safety model said DENY` });
        else if (d.act !== r.act) f.push({ rule: "B3_UNAPPROVED_ACTION", seq: r.seq, detail: `approval was for ${d.act}, not ${r.act}` });
        else if (d.used) f.push({ rule: "B3_UNAPPROVED_ACTION", seq: r.seq, detail: "approval reused" });
        else if (r.t - d.t > permit.approvalTtlMs || r.t < d.t) f.push({ rule: "B3_UNAPPROVED_ACTION", seq: r.seq, detail: "approval was stale" });
        if (d) d.used = true;
        break;
      }
    }
  }
  return { breach: f.length > 0, findings: f };
}
