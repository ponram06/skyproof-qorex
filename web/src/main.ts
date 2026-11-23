import "./polyfill";
import { buildSettlementReceipt, createRdkClient, verifySettlementReceipt } from "@qorechain/rdk";
import { parseHeaderPost, verifyHeader, type SegmentHeader } from "./verify";
import { drawFlight, openFlight, type InvestigatorData } from "./investigator";
import { mountReplay, type ReplayHandle, type Rec } from "./replay3d";
import { simulate, SIM_SCENARIOS, type SimScenario } from "../../rollup/src/sim/sim";
import { DEMO_PERMIT } from "../../rollup/src/flight/scenarios";
import { judge } from "../../rollup/src/rules";

interface Data {
  generatedAt: string;
  chainId: string;
  rollup: { rollupId: string; creator: string; status: string; settlementMode: string; executionVm: string; sequencing: string; layerId: string; challengeWindowSec?: number; stakeAmount: string };
  drones: Record<string, { publicKey: string; permit: { maxAltM: number; maxWindMs: number; area: { r: number } } }>;
  batches: { index: number; status: string; inboxStart: number; inboxEnd: number; submittedTime: number; tx?: string; withdrawals: { recipient: string; amount: string }[] }[];
  headers: { batch: number; seq: number; height: number; post: string }[];
  posts: { batch: number; seq: number; height: number; poster: string; kind: string; detail: string }[];
  fraud?: { tx: string; height: number; batch: string; challenger: string; slashed: string; burned: string }[];
  withdrawalsExecuted?: Record<string, string>;
  claims: { flight: string; victim: string; note: string; status: string; verdict?: { breach: boolean; findings: { rule: string; detail: string; seq?: number }[] } }[];
}

const RULES: Record<string, string> = {
  B1_GEOFENCE: "left the permitted area / entered a no-fly zone",
  B2_ALTITUDE: "flew above the altitude ceiling",
  B3_UNAPPROVED_ACTION: "acted without a fresh, matching safety approval",
  B4_OVERRIDE: "acted after the safety model said DENY",
  B5_RECORD_BROKEN: "record missing, edited, withheld or never closed",
  B6_WIND: "took off in wind above the limit",
};

const client = createRdkClient({ network: "testnet", endpoints: { rest: `${location.origin}/api/rest`, rpc: `${location.origin}/api/rpc` } });
const $ = (id: string) => document.getElementById(id)!;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const qor = (uqor: string | number) => (Number(uqor) / 1e6).toLocaleString(undefined, { maximumFractionDigits: 6 });
const short = (s: string, n = 10) => (s.length > 2 * n ? `${s.slice(0, n)}…${s.slice(-6)}` : s);
const tag = (ok: boolean | "warn", text: string) => `<span class="tag ${ok === "warn" ? "warn" : ok ? "ok" : "bad"}">${esc(text)}</span>`;

async function main() {
  const data: Data = await fetch("/skyproof.json", { cache: "no-store" }).then((r) => r.json());
  $("generated").textContent = `data exported ${new Date(data.generatedAt).toLocaleString()}`;
  setupSimulator();
  renderRollup(data);
  renderFlights(data);
  renderBatches(data);
  renderPosts(data);
  renderFraud(data);
  setupInvestigator(data);
  live(data).catch(() => ($("live").textContent = "chain offline: showing exported data"));
}

function renderRollup(d: Data) {
  const r = d.rollup;
  const cards: [string, string][] = [
    ["Rollup", r.rollupId],
    ["Status", r.status],
    ["Settlement", `${r.settlementMode}, ${r.executionVm}`],
    ["Sequencing", r.sequencing],
    ["Challenge window", `${r.challengeWindowSec ?? "?"} s`],
    ["Stake", `${qor(r.stakeAmount)} QOR`],
    ["Batches", String(d.batches.length)],
    ["Creator", short(r.creator, 12)],
  ];
  $("rollup").innerHTML = cards.map(([k, v]) => `<div class="card"><div class="k">${k}</div><div class="v">${esc(v)}</div></div>`).join("");
}

function renderFlights(d: Data) {
  const byFlight = new Map<string, { header: SegmentHeader; signature: Uint8Array; batch: number; seq: number }[]>();
  for (const h of d.headers) {
    const p = parseHeaderPost(h.post);
    (byFlight.get(p.header.flight) ?? byFlight.set(p.header.flight, []).get(p.header.flight)!).push({ ...p, batch: h.batch, seq: h.seq });
  }
  const bodies = new Set(d.posts.filter((p) => p.kind === "sealed body").map((p) => p.detail.split("sha256 ")[1]?.replace("…", "")));

  const html = [...byFlight.entries()].map(([flight, segs]) => {
    segs.sort((a, b) => a.header.idx - b.header.idx);
    const drone = d.drones[segs[0].header.drone];
    let prev = "00".repeat(32);
    const segHtml = segs.map((s, i) => {
      const sigOk = !!drone && verifyHeader(s.header, s.signature, drone.publicKey);
      const chainOk = s.header.prev === prev;
      prev = s.header.head;
      const sealed = bodies.has(s.header.body.slice(0, 16));
      return `<div class="seg" data-flight="${esc(flight)}" data-i="${i}">
        <div class="row"><b>Segment ${s.header.idx}</b><span class="muted">records ${s.header.first}–${s.header.first + s.header.n - 1}</span></div>
        <div class="row"><span>drone ML-DSA-87 signature</span><span class="sig">${tag(sigOk, sigOk ? "valid" : "INVALID")}</span></div>
        <div class="row"><span>continues previous segment</span>${tag(chainOk, chainOk ? "yes" : "NO")}</div>
        <div class="row"><span>ML-KEM sealed body on chain</span>${tag(sealed ? true : "warn", sealed ? "present" : "withheld")}</div>
        <div class="row"><span>batch · inbox</span><span class="muted">#${s.batch} · ${s.seq}</span></div>
        <div class="mono muted">head ${short(s.header.head, 12)}</div>
      </div>`;
    });
    const claim = d.claims.find((c) => c.flight === flight);
    const rules = [...new Set(claim?.verdict?.findings.map((f) => f.rule) ?? [])];
    const verdict = !claim
      ? ""
      : claim.status === "paid"
        ? `<div class="verdict paid"><b>Breach: victim paid 5 QOR.</b> ${rules.map((r) => `${r.replace("_", " ")}: ${RULES[r] ?? ""}`).join("; ")}</div>`
        : claim.status === "rejected"
          ? `<div class="verdict rejected"><b>No rule broken: claim rejected.</b> The record is intact and every action had a fresh approval.</div>`
          : `<div class="verdict open">Claim open: waiting for the record.</div>`;
    return `<article class="flight">
      <div class="flight-head"><h3>${esc(flight)}</h3><button data-cheat="${esc(flight)}">Try to cheat: edit this record</button></div>
      <div class="segs">${segHtml.join("")}</div>
      ${verdict}
    </article>`;
  });
  $("flights").innerHTML = html.join("") || `<p class="muted">No flights yet.</p>`;

  // "Try to cheat": change one field of a signed header and verify again, in the browser.
  $("flights").querySelectorAll<HTMLButtonElement>("button[data-cheat]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const flight = btn.dataset.cheat!;
      const segs = byFlight.get(flight)!;
      const s = segs[0];
      const drone = d.drones[s.header.drone];
      const forged: SegmentHeader = { ...s.header, n: s.header.n - 1 }; // pretend a record never existed
      const ok = verifyHeader(forged, s.signature, drone.publicKey);
      const el = document.querySelector<HTMLElement>(`.seg[data-flight="${CSS.escape(flight)}"][data-i="0"] .sig`)!;
      el.innerHTML = tag(ok, ok ? "valid" : "INVALID after edit");
      btn.textContent = ok ? "Edit went unnoticed?!" : "Edited: the drone's signature no longer matches";
      btn.disabled = true;
    }),
  );
}

function renderBatches(d: Data) {
  const rows = d.batches.map(
    (b) => `<tr>
      <td><b>#${b.index}</b></td>
      <td>${b.inboxEnd - b.inboxStart} posts <span class="muted">(${b.inboxStart + 1}–${b.inboxEnd})</span></td>
      <td>${b.withdrawals.length ? b.withdrawals.map((w: { index?: string; recipient: string; amount: string }) => `${qor(w.amount)} QOR → ${short(w.recipient, 8)} ${w.index !== undefined && d.withdrawalsExecuted?.[w.index] ? tag(true, "paid on QoreChain") : ""}`).join("<br>") : '<span class="muted">none</span>'}</td>
      <td class="status" data-b="${b.index}">${b.status === "finalized" ? tag(true, "finalized") : tag("warn", b.status)}</td>
      <td><button class="primary" data-receipt="${b.index}">Verify receipt</button><ul class="checks" id="r${b.index}"></ul></td>
    </tr>`,
  );
  $("batches").innerHTML = `<div class="scroll"><table class="table"><thead><tr><th>Batch</th><th>Inbox</th><th>Withdrawals</th><th>Status</th><th>Settlement receipt</th></tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
  $("batches").querySelectorAll<HTMLButtonElement>("button[data-receipt]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const i = Number(btn.dataset.receipt);
      const out = $(`r${i}`);
      btn.disabled = true;
      btn.textContent = "Checking against QoreChain…";
      try {
        const receipt = await buildSettlementReceipt(client, d.rollup.rollupId, i);
        const v = await verifySettlementReceipt(receipt, { client });
        out.innerHTML = Object.entries(v.checks ?? {}).map(([k, ok]) => `<li class="${ok ? "" : "no"}">${esc(k)}</li>`).join("");
        btn.textContent = v.valid ? `VALID: anchored at height ${v.anchor?.mainChainHeight}, ${receipt.algorithm}` : "NOT VALID";
      } catch (e) {
        btn.textContent = `Could not check: ${e instanceof Error ? e.message : e}`;
      }
    }),
  );
}

const ABOUT: Record<SimScenario, string> = {
  normal: "A clean delivery: every action has a fresh ALLOW. Expected: no rule broken.",
  people_below: "A person stands at the drop pad. The gate says DENY; the drone hovers and asks again, then drops on a fresh ALLOW. Expected: no rule broken.",
  link_lost: "The gate stops answering. The drone never invents an approval and does a safe stop. Expected: no rule broken.",
  cheating: "A person stays at the drop pad; the operator drops anyway after the DENY. Expected: B4 override.",
  unapproved: "The operator drops without asking the gate at all. Expected: B3 unapproved action.",
  shortcut: "The operator flies straight across the no-fly zone. Expected: B1 geofence.",
  altitude: "The operator cruises above the 120 m ceiling. Expected: B2 altitude.",
  wind: "Gusty day: the gate denies take-off; the operator flies anyway. Expected: B6 wind and B4 override.",
};
let replay: ReplayHandle | undefined;
const showReplay = (el: HTMLElement, recs: Rec[], permit: typeof DEMO_PERMIT, verdict: ReturnType<typeof judge>) => {
  replay?.dispose();
  replay = mountReplay(el, recs, permit, verdict);
};

function setupSimulator() {
  const sel = $("simScenario") as HTMLSelectElement;
  sel.innerHTML = SIM_SCENARIOS.map((s) => `<option value="${s}">${s.replace("_", " ")}</option>`).join("");
  const about = () => ($("simAbout").textContent = ABOUT[sel.value as SimScenario]);
  sel.onchange = about;
  about();
  ($("simFly") as HTMLButtonElement).onclick = () => {
    const scenario = sel.value as SimScenario;
    const recs = simulate({ scenario, flight: `demo-${scenario}`, drone: "SKY-001", permit: DEMO_PERMIT, permitHash: "demo", seed: Math.floor(Math.random() * 1e5) });
    const verdict = judge(recs, DEMO_PERMIT);
    const rules = [...new Set(verdict.findings.map((f) => f.rule))];
    $("simOut").innerHTML = `<div class="replay"><div id="simView"></div><div class="card">
        <div class="k">${recs.length} records · ${recs.filter((r) => r.k === "DECISION").length} gate decisions</div>
        <p><b>Verdict:</b> ${verdict.breach ? tag(false, rules.join(", ")) : tag(true, "no rule broken")}</p>
        <ul class="findings">${verdict.findings.map((f) => `<li><b>${esc(f.rule.replace("_", " "))}</b>${f.seq !== undefined ? ` (record #${f.seq})` : ""}: ${esc(f.detail)}</li>`).join("")}</ul>
        <p class="muted small">On QoreChain, this record would be sealed with ML-KEM-1024, signed by the drone with ML-DSA-87, settled in a batch and judged by the watchtower exactly like this.</p>
      </div></div>`;
    showReplay($("simView"), recs as Rec[], DEMO_PERMIT, verdict);
  };
}

function setupInvestigator(d: Data) {
  const flights = [...new Set(d.headers.map((h) => parseHeaderPost(h.post).header.flight))];
  const sel = $("invFlight") as HTMLSelectElement;
  sel.innerHTML = flights.map((f) => `<option>${esc(f)}</option>`).join("");
  let key: { address: string; seed: string } | undefined;
  const btn = $("invOpen") as HTMLButtonElement;
  ($("invKey") as HTMLInputElement).addEventListener("change", async (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    try {
      const k = JSON.parse(await file.text());
      key = { address: k.address, seed: k.mlkem1024Seed };
      btn.disabled = !key.address || !key.seed;
    } catch {
      $("invOut").innerHTML = `<p class="verdict paid">That is not an investigator key file.</p>`;
    }
  });
  btn.addEventListener("click", () => {
    if (!key) return;
    try {
      const r = openFlight(d as unknown as InvestigatorData, sel.value, key);
      const rules = r.verdict.findings;
      const decisions = r.recs.filter((x) => x.k === "DECISION");
      const actions = r.recs.filter((x) => x.k === "ACTION");
      $("invOut").innerHTML = `<div class="replay">
        <div id="invView"></div>
        <div class="card">
          <div class="k">Opened ${r.segments} sealed segments · ${r.recs.length} records</div>
          <p>${r.errors.length ? tag(false, "record problems") : tag(true, "every segment matches its drone-signed header")}</p>
          <p><b>Safety decisions:</b> ${decisions.map((x) => `${x.act} ${x.ok ? "ALLOW" : "DENY"}`).join(" · ") || "none (link lost)"}</p>
          <p><b>Actions:</b> ${actions.map((x) => x.act).join(" · ")}</p>
          <p><b>Verdict:</b> ${r.verdict.breach ? tag(false, "rule broken") : tag(true, "no rule broken")}</p>
          <ul class="findings">${rules.map((f) => `<li><b>${esc(f.rule.replace("_", " "))}</b> ${f.seq !== undefined ? `(record #${f.seq})` : ""}: ${esc(f.detail)}</li>`).join("")}</ul>
          <p class="muted small">Top-down map: dashed green = permitted area, red = no-fly zone, purple = path, dots = actions (green), DENY decisions (orange), breaches (red).</p>
          <div class="map small">${r.permit ? drawFlight(r.recs, r.permit, r.verdict) : ""}</div>
        </div>
      </div>`;
      if (r.permit) showReplay($("invView"), r.recs as Rec[], r.permit, r.verdict);
    } catch (err) {
      $("invOut").innerHTML = `<p class="verdict paid">Could not open: ${esc(err instanceof Error ? err.message : String(err))}</p>`;
    }
  });
}

function renderFraud(d: Data) {
  const rows = (d.fraud ?? []).map(
    (f) => `<tr><td>#${esc(f.batch)}</td><td class="mono">${esc(short(f.tx, 10))}</td><td>${f.height.toLocaleString()}</td><td>${qor(f.slashed.replace("uqor", ""))} QOR slashed, ${qor(f.burned.replace("uqor", ""))} burned</td><td class="mono">${esc(short(f.challenger, 10))}</td></tr>`,
  );
  $("fraud").innerHTML = rows.length
    ? `<div class="scroll"><table class="table"><thead><tr><th>Batch</th><th>Tx</th><th>Height</th><th>Penalty</th><th>Challenger</th></tr></thead><tbody>${rows.join("")}</tbody></table></div>
       <p class="muted small">A second, bonded submitter published a batch whose withdrawals root paid the whole pool to itself. The chain re-executed it, upheld the fraud proof and rolled the inbox back; the honest batch replaced it.</p>`
    : `<p class="muted">None so far.</p>`;
}

function renderPosts(d: Data) {
  const rows = d.posts.map((p) => `<tr><td>${p.seq}</td><td>#${p.batch}</td><td>${esc(p.kind)}</td><td class="mono">${esc(short(p.poster.replace("deposit:", ""), 10))}</td><td class="mono">${esc(p.detail)}</td></tr>`);
  $("posts").innerHTML = `<div class="scroll"><table class="table"><thead><tr><th>#</th><th>Batch</th><th>Kind</th><th>Poster</th><th>Detail</th></tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
}

/** Live status from QoreChain: rollup, latest batch, and time left in each challenge window. */
async function live(d: Data) {
  const tick = async () => {
    const [r, tip] = await Promise.all([client.rest.getRollup(d.rollup.rollupId), client.getChainTip()]);
    const latest = await client.rest.getLatestBatch(d.rollup.rollupId);
    $("live").className = "pill on";
    $("live").textContent = `● live · ${r.status} · batch #${latest.batchIndex} · height ${tip.height.toLocaleString()}`;
    const win = r.challengeWindowSec ?? 3600;
    for (const b of d.batches) {
      const cell = document.querySelector<HTMLElement>(`.status[data-b="${b.index}"]`);
      if (!cell) continue;
      const view = await client.rest.getBatch(d.rollup.rollupId, b.index);
      const left = view.submittedTime + win - tip.timeSecs;
      cell.innerHTML = view.status === "finalized" ? tag(true, "finalized") : tag("warn", left > 0 ? `${view.status} · final in ${Math.ceil(left / 60)} min` : `${view.status} · window closed`);
    }
  };
  await tick();
  setInterval(() => tick().catch(() => undefined), 20_000);
}

main();
