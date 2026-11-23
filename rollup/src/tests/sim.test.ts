import assert from "node:assert/strict";
import { test } from "node:test";
import { GENESIS } from "../flight/record.js";
import { DEMO_PERMIT } from "../flight/scenarios.js";
import { MAX_POST, sealSegment } from "../flight/segment.js";
import { judge } from "../rules.js";
import { simulate, SIM_SCENARIOS, type SimScenario } from "../sim/sim.js";
import { hex } from "../util.js";
import { DRONE, ENV, RECIPIENTS } from "./fixtures.js";

const EXPECT: Record<SimScenario, string[]> = {
  normal: [],
  people_below: [],
  link_lost: [],
  cheating: ["B4_OVERRIDE"],
  unapproved: ["B3_UNAPPROVED_ACTION"],
  shortcut: ["B1_GEOFENCE"],
  altitude: ["B2_ALTITUDE"],
  wind: ["B4_OVERRIDE", "B6_WIND"],
};

const run = (scenario: SimScenario) => simulate({ scenario, flight: `F-${scenario}`, drone: DRONE.id, permit: DEMO_PERMIT, permitHash: "p", t0: 1_795_000_000_000 });

for (const s of SIM_SCENARIOS) {
  test(`sim ${s}: the judge finds exactly ${EXPECT[s].join(", ") || "nothing"}`, () => {
    const rules = [...new Set(judge(run(s), DEMO_PERMIT).findings.map((f) => f.rule))].sort();
    assert.deepEqual(rules, EXPECT[s]);
  });
}

test("people_below: DENY while someone is at the drop point, then a fresh ALLOW", () => {
  const drops = run("people_below").filter((r) => r.k === "DECISION" && r.act === "DROP") as { ok: boolean }[];
  assert.ok(drops.length >= 3);
  assert.deepEqual(drops.map((d) => d.ok).slice(0, 2), [false, false]);
  assert.equal(drops[drops.length - 1].ok, true);
});

test("link_lost: no decision is ever recorded and no gated action happens", () => {
  const r = run("link_lost");
  assert.equal(r.filter((x) => x.k === "DECISION").length, 0);
  assert.deepEqual(r.filter((x) => x.k === "ACTION").map((x) => (x as { act: string }).act), ["SAFE_STOP"]);
});

test("the same seed gives the same flight", () => {
  assert.deepEqual(run("people_below"), run("people_below"));
});

test("every simulated flight seals into posts under the size limit", () => {
  for (const s of SIM_SCENARIOS) {
    const recs = run(s);
    let prev = hex(GENESIS);
    for (let i = 0, idx = 0; i < recs.length; i += 12, idx++) {
      const seg = sealSegment({ ...ENV, recipients: RECIPIENTS }, { id: DRONE.id, secretKey: DRONE.secretKey }, { flight: `F-${s}`, idx, prev, recs: recs.slice(i, i + 12) });
      assert.ok(seg.bodyPost.length <= MAX_POST && seg.headerPost.length <= MAX_POST, `${s} segment ${idx}`);
      prev = seg.header.head;
    }
  }
});
