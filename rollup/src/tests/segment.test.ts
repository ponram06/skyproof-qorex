import assert from "node:assert/strict";
import { test } from "node:test";
import { generatePqcKeypair } from "@qorechain/sdk";
import { GENESIS, type FlightRecord } from "../flight/record.js";
import { MAX_POST, openSegment, parseHeaderPost, sealSegment, verifyHeader } from "../flight/segment.js";
import { hex } from "../util.js";
import { cleanFlight, DRONE, ENV, fixedRandom, INSURER, INVESTIGATOR, RECIPIENTS, STRANGER } from "./fixtures.js";

const ctx = { ...ENV, recipients: RECIPIENTS };
const seal = (recs: FlightRecord[], idx = 0, prev = hex(GENESIS)) =>
  sealSegment(ctx, { id: DRONE.id, secretKey: DRONE.secretKey }, { flight: "F1", idx, prev, recs }, fixedRandom);

test("a segment fits in two posts and its header is signed by the drone", () => {
  const s = seal(cleanFlight());
  assert.ok(s.bodyPost.length <= MAX_POST, `body ${s.bodyPost.length}`);
  assert.ok(s.headerPost.length <= MAX_POST, `header ${s.headerPost.length}`);
  const h = parseHeaderPost(s.headerPost);
  assert.equal(h.header.fin, true);
  assert.ok(verifyHeader(h, DRONE.publicKey));
});

test("a header signed by another key is rejected", () => {
  const s = seal(cleanFlight());
  const other = generatePqcKeypair(new Uint8Array(32).fill(8));
  assert.equal(verifyHeader(parseHeaderPost(s.headerPost), other.publicKey), false);
});

test("an edited header no longer verifies", () => {
  const h = parseHeaderPost(seal(cleanFlight()).headerPost);
  assert.equal(verifyHeader({ ...h, header: { ...h.header, fin: false } }, DRONE.publicKey), false);
});

test("the investigator and the insurer can both open the records", () => {
  const recs = cleanFlight();
  const s = seal(recs);
  for (const who of [INVESTIGATOR, INSURER]) {
    const out = openSegment(ENV, s.bodyPost, s.header, { address: who.address, decapsulationKey: who.seed });
    assert.deepEqual(out.errors, []);
    assert.deepEqual(out.recs, recs);
  }
});

test("someone who is not a recipient cannot open the records", () => {
  const s = seal(cleanFlight());
  assert.throws(() => openSegment(ENV, s.bodyPost, s.header, { address: STRANGER.address, decapsulationKey: STRANGER.seed }));
});

test("a body swapped under a signed header is caught", () => {
  const a = seal(cleanFlight());
  const edited = cleanFlight();
  (edited[5] as { alt: number }).alt = 300;
  const b = seal(edited);
  const out = openSegment(ENV, b.bodyPost, a.header, { address: INVESTIGATOR.address, decapsulationKey: INVESTIGATOR.seed });
  assert.ok(out.errors.some((e) => e.includes("body does not match")));
  assert.ok(out.errors.some((e) => e.includes("head hash")));
});

test("segments chain: the second starts from the first one's head", () => {
  const recs = cleanFlight();
  const s1 = seal(recs.slice(0, 10), 0);
  const s2 = seal(recs.slice(10), 1, s1.header.head);
  const out = openSegment(ENV, s2.bodyPost, s2.header, { address: INSURER.address, decapsulationKey: INSURER.seed });
  assert.deepEqual(out.errors, []);
  assert.equal(s2.header.first, 10);
});

test("a deleted record breaks the chain", () => {
  const recs = cleanFlight();
  recs.splice(4, 1);
  assert.throws(() => seal(recs), /expected seq/);
});
