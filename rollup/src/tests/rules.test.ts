import assert from "node:assert/strict";
import { test } from "node:test";
import type { FlightRecord, SampleRec } from "../flight/record.js";
import { judge, type RuleCode } from "../rules.js";
import { cleanFlight, PERMIT } from "./fixtures.js";

const rulesOf = (recs: FlightRecord[], errs: string[] = []) => new Set(judge(recs, PERMIT, errs).findings.map((f) => f.rule));
const sample = (recs: FlightRecord[], i: number) => recs[i] as SampleRec;
const only = (recs: FlightRecord[], rule: RuleCode) => assert.deepEqual([...rulesOf(recs)], [rule]);

test("a clean flight breaks no rule", () => {
  const v = judge(cleanFlight(), PERMIT);
  assert.deepEqual(v.findings, []);
  assert.equal(v.breach, false);
});

test("B1: leaving the permitted area", () => {
  const r = cleanFlight();
  sample(r, 6).lat = 19.2;
  only(r, "B1_GEOFENCE");
});

test("B1: entering a no-fly zone", () => {
  const r = cleanFlight();
  sample(r, 6).lat = 19.09;
  only(r, "B1_GEOFENCE");
});

test("B2: above the altitude ceiling", () => {
  const r = cleanFlight();
  sample(r, 6).alt = 150;
  only(r, "B2_ALTITUDE");
});

test("B3: an action with no decision", () => {
  only(cleanFlight().filter((x) => !(x.k === "DECISION" && x.req === "r2")), "B3_UNAPPROVED_ACTION");
});

test("B3: a stale approval", () => {
  const r = cleanFlight();
  const i = r.findIndex((x) => x.k === "ACTION" && x.req === "r2");
  r.slice(i).forEach((x) => (x.t += 60_000));
  only(r, "B3_UNAPPROVED_ACTION");
});

test("B3: one approval used twice", () => {
  const r = cleanFlight();
  const i = r.findIndex((x) => x.k === "ACTION" && x.req === "r2");
  r.splice(i + 1, 0, { ...r[i], t: r[i].t + 100 });
  only(r, "B3_UNAPPROVED_ACTION");
});

test("B4: acting after a DENY", () => {
  const r = cleanFlight();
  (r.find((x) => x.k === "DECISION" && x.req === "r2") as { ok: boolean }).ok = false;
  only(r, "B4_OVERRIDE");
});

test("B5: integrity errors and a missing CLOSE", () => {
  assert.ok(rulesOf(cleanFlight(), ["segment 2 withheld"]).has("B5_RECORD_BROKEN"));
  only(cleanFlight().filter((x) => x.k !== "CLOSE"), "B5_RECORD_BROKEN");
});

test("B6: taking off in strong wind", () => {
  const r = cleanFlight();
  sample(r, 1).wind = 20;
  only(r, "B6_WIND");
});
