import "./polyfill";
import { buildSettlementReceipt, createRdkClient, verifySettlementReceipt } from "@qorechain/rdk";
import { parseHeaderPost, verifyHeader, type SegmentHeader } from "./verify";
import { drawFlight, openFlight, type InvestigatorData } from "./investigator";
import { mountArena, type ArenaHandle, type Rec } from "./arena";
import { simulate, SIM_SCENARIOS, type SimScenario } from "../../rollup/src/sim/sim";
import { DEMO_PERMIT } from "../../rollup/src/flight/scenarios";
import { judge, type Verdict } from "../../rollup/src/rules";

interface Data {
  generatedAt: string;
  chainId: string;
  rollup: { rollupId: string; creator: string; status: string; settlementMode: string; executionVm: string; sequencing: string; layerId: string; challengeWindowSec?: number; stakeAmount: string };
  drones: Record<string, { publicKey: string }>;
  batches: { index: number; status: string; inboxStart: number; inboxEnd: number; submittedTime: number; tx?: string; withdrawals: { index?: string; recipient: string; amount: string }[] }[];
  headers: { batch: number; seq: number; height: number; post: string }[];
  bodies?: Record<string, string>;
  posts: { batch: number; seq: number; height: number; poster: string; kind: string; detail: string }[];
  fraud?: { tx: string; height: number; batch: string; challenger: string; slashed: string; burned: string }[];
  withdrawalsExecuted?: Record<string, string>;
  claims: { flight: string; victim: string; note: string; status: string; verdict?: Verdict }[];
  watchtower?: { batch: number; valid: boolean; note: string }[];
}

const RULE_TEXT: Record<string, string> = {
  B1_GEOFENCE: "left the permitted area or entered a no-fly zone",
  B2_ALTITUDE: "flew above the altitude ceiling",
  B3_UNAPPROVED_ACTION: "acted without a fresh, matching safety approval",
  B4_OVERRIDE: "acted after the safety gate said DENY",
  B5_RECORD_BROKEN: "record missing, edited, withheld or never closed",
  B6_WIND: "took off in wind above the limit",
};
const ABOUT: Record<SimScenario, string> = {
  normal: "A clean delivery. Every take-off, drop and landing has a fresh ALLOW.",
  people_below: "A person stands at the drop pad. The gate says DENY, the drone holds and asks again, and drops when they walk away.",
  link_lost: "The gate stops answering. The drone never invents an approval and lands where it is.",
  cheating: "A person stays at the drop pad, and the operator drops the parcel anyway after the gate says DENY.",
  unapproved: "The operator drops the parcel without asking the gate at all.",
  shortcut: "The operator flies straight across the no-fly zone to save time.",
  altitude: "The operator cruises above the 120 m ceiling.",
  wind: "A gusty day: the gate denies take-off, and the operator flies anyway.",
};
const BREACHES: Partial<Record<SimScenario, string>> = { cheating: "B4", unapproved: "B3", shortcut: "B1", altitude: "B2", wind: "B6" };

const client = createRdkClient({ network: "testnet", endpoints: { rest: `${location.origin}/api/rest`, rpc: `${location.origin}/api/rpc` } });
const $ = (id: string) => document.getElementById(id)!;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const qor = (uqor: string | number) => (Number(uqor) / 1e6).toLocaleString(undefined, { maximumFractionDigits: 2 });
const short = (s: string, n = 10) => (s.length > 2 * n ? `${s.slice(0, n)}…${s.slice(-6)}` : s);
const tag = (ok: boolean | "warn", text: string) => `<span class="tag ${ok === "warn" ? "warn" : ok ? "ok" : "bad"}">${esc(text)}</span>`;
const ruleName = (r: string) => r.replace(/_/g, " ").replace(/^(B\d) /, "$1 · ");

async function main() {
  setupArena();
  const data: Data = await fetch("/skyproof.json", { cache: "no-store" }).then((r) => r.json());
  $("generated").textContent = `data exported ${new Date(data.generatedAt).toLocaleDateString()}`;
  renderStatus(data);
  renderStats(data);
  renderFlights(data);
  renderBatches(data);
  renderFraud(data);
  renderPosts(data);
  setupInvestigator(data);
  live(data).catch((e) => {
    console.error("live status:", e);
    $("live").textContent = "chain offline · exported data";
  });
}

/* ---------------- hero: system status + stats ---------------- */

function renderStatus(d: Data) {
  const paid = Object.keys(d.withdrawalsExecuted ?? {}).length;
  const rows: [string, string, boolean][] = [
    ["ML-DSA-87 · drone-signed records", `${d.headers.length} segs`, d.headers.length > 0],
    ["ML-KEM-1024 · sealed bodies", `${Object.keys(d.bodies ?? {}).length}`, Object.keys(d.bodies ?? {}).length > 0],
    [`x/rdk rollup · ${d.rollup.rollupId}`, d.rollup.status, d.rollup.status === "active"],
    ["Batches · ML-DSA-87 anchors", `${d.batches.length}`, d.batches.length > 0],
    ["Settlement receipts · 6 checks", "verify", true],
    ["Watchtower · re-execution", `${d.watchtower?.length ?? 0} runs`, (d.watchtower?.length ?? 0) > 0],
    ["Fraud proofs upheld", `${d.fraud?.length ?? 0}`, (d.fraud?.length ?? 0) > 0],
    ["Withdrawals paid on QoreChain", `${paid}`, paid > 0],
    ["Safety gate · fresh ALLOW only", "on", true],
    ["Safe stop · no fake approvals", "on", true],
  ];
  $("status").innerHTML = rows.map(([k, v, ok]) => `<li><span>${esc(k)}</span><span class="dot ${ok ? "" : "wait"}">${esc(v)} ●</span></li>`).join("");
}

function renderStats(d: Data) {
  const flights = new Set(d.headers.map((h) => parseHeaderPost(h.post).header.flight));
  const records = d.headers.reduce((n, h) => n + parseHeaderPost(h.post).header.n, 0);
  const paid = d.batches.flatMap((b) => b.withdrawals).filter((w) => w.index !== undefined && d.withdrawalsExecuted?.[w.index]).reduce((s, w) => s + Number(w.amount), 0);
  const stats: [string, string, boolean?][] = [
    [String(flights.size), "flights on chain"],
    [records.toLocaleString(), "signed records"],
    [String(d.posts.length), "inbox posts"],
    [`${qor(paid)}`, "QOR paid to victims", true],
    [String(d.fraud?.length ?? 0), "fraud proofs upheld"],
  ];
  $("stats").innerHTML = stats.map(([v, k, lime]) => `<div class="stat ${lime ? "lime" : ""}"><b>${esc(v)}</b><span>${esc(k)}</span></div>`).join("");
}

/* ---------------- arena ---------------- */

let arena: ArenaHandle | undefined;
function setupArena() {
  const chips = $("chips");
  chips.innerHTML = SIM_SCENARIOS.map((s) => `<button class="chip" data-s="${s}">${s.replace("_", " ")}${BREACHES[s] ? ` <span class="b">${BREACHES[s]}</span>` : ""}</button>`).join("");
  const fly = (s: SimScenario) => {
    chips.querySelectorAll(".chip").forEach((c) => c.classList.toggle("on", (c as HTMLElement).dataset.s === s));
    const recs = simulate({ scenario: s, flight: `demo-${s}`, drone: "SKY-001", permit: DEMO_PERMIT, permitHash: "demo", seed: 7 + SIM_SCENARIOS.indexOf(s) });
    const verdict = judge(recs, DEMO_PERMIT);
    arena?.dispose();
    arena = mountArena($("simView"), recs as Rec[], DEMO_PERMIT, verdict, { autoplay: true });
    const rules = [...new Set(verdict.findings.map((f) => f.rule))];
    const dec = recs.filter((r) => r.k === "DECISION") as { ok: boolean }[];
    $("simVerdict").innerHTML = `
      <div class="kicker">Scenario · ${esc(s.replace("_", " "))}</div>
      <p class="vp-about">${esc(ABOUT[s])}</p>
      <div class="kicker">Verdict of the six rules</div>
      <div class="verdict-big ${verdict.breach ? "bad" : "ok"}">${verdict.breach ? `Breach: ${rules.map((r) => r.slice(0, 2)).join(" + ")}. The victim is paid.` : "No rule broken. The claim is rejected."}</div>
      <ul class="findings">${verdict.findings.map((f) => `<li><b>${esc(ruleName(f.rule))}</b>${f.seq !== undefined ? ` · record #${f.seq}` : ""}<br>${esc(f.detail)}</li>`).join("")}</ul>
      <div class="facts">
        <div><b>${recs.length}</b><span>records</span></div>
        <div><b>${dec.length}</b><span>gate decisions</span></div>
        <div><b>${dec.filter((x) => !x.ok).length}</b><span>DENY</span></div>
        <div><b>${Math.round((recs[recs.length - 1].t - recs[0].t) / 1000)} s</b><span>flight time</span></div>
      </div>
      <p class="note">On QoreChain this record is sealed with ML-KEM-1024, signed with ML-DSA-87, settled in a batch and judged by the watchtower with exactly this code.</p>`;
  };
  chips.querySelectorAll<HTMLButtonElement>(".chip").forEach((c) => (c.onclick = () => fly(c.dataset.s as SimScenario)));
  fly("people_below");
}

/* ---------------- flights on chain ---------------- */

function renderFlights(d: Data) {
  const byFlight = new Map<string, { header: SegmentHeader; signature: Uint8Array; batch: number; seq: number }[]>();
  for (const h of d.headers) {
    const p = parseHeaderPost(h.post);
    (byFlight.get(p.header.flight) ?? byFlight.set(p.header.flight, []).get(p.header.flight)!).push({ ...p, batch: h.batch, seq: h.seq });
  }
  const bodies = new Set(Object.keys(d.bodies ?? {}));

  const html = [...byFlight.entries()].map(([flight, segs]) => {
    segs.sort((a, b) => a.header.idx - b.header.idx);
    const drone = d.drones[segs[0].header.drone];
    let prev = "00".repeat(32);
    let allOk = true;
    const segHtml = segs.map((s, i) => {
      const sigOk = !!drone && verifyHeader(s.header, s.signature, drone.publicKey);
      const chainOk = s.header.prev === prev;
      prev = s.header.head;
      const sealed = bodies.has(s.header.body);
      allOk &&= sigOk && chainOk && sealed;
      return `<div class="seg" data-flight="${esc(flight)}" data-i="${i}">
        <div class="row"><b>Segment ${s.header.idx}</b><span class="muted">#${s.header.first}–${s.header.first + s.header.n - 1}</span></div>
        <div class="row"><span>ML-DSA-87</span><span class="sig">${tag(sigOk, sigOk ? "valid" : "invalid")}</span></div>
        <div class="row"><span>chained</span>${tag(chainOk, chainOk ? "yes" : "no")}</div>
        <div class="row"><span>ML-KEM body</span>${tag(sealed ? true : "warn", sealed ? "sealed" : "withheld")}</div>
      </div>`;
    });
    const claim = d.claims.find((c) => c.flight === flight);
    const rules = [...new Set(claim?.verdict?.findings.map((f) => f.rule) ?? [])];
    const verdict = !claim
      ? ""
      : claim.status === "paid"
        ? `<div class="verdict paid"><b>Breach · victim paid 5 QOR.</b> ${rules.map((r) => `${ruleName(r)}: ${RULE_TEXT[r] ?? ""}`).join("; ")}</div>`
        : claim.status === "rejected"
          ? `<div class="verdict rejected"><b>No rule broken · claim rejected.</b> The record is intact and every action had a fresh approval.</div>`
          : `<div class="verdict open">Claim open: waiting for the record.</div>`;
    return `<article class="flight">
      <div class="flight-head"><h3>${esc(flight)}</h3>
        <div class="flight-tags">${tag(allOk, allOk ? `${segs.length} segments verified` : "problem")}<button class="btn" data-cheat="${esc(flight)}">Try to cheat</button></div>
      </div>
      <div class="segs">${segHtml.join("")}</div>
      ${verdict}
    </article>`;
  });
  $("flightList").innerHTML = html.join("") || `<p class="muted">No flights yet.</p>`;

  // "Try to cheat": remove one record from a signed header and verify again, in the browser.
  $("flightList").querySelectorAll<HTMLButtonElement>("button[data-cheat]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const flight = btn.dataset.cheat!;
      const s = byFlight.get(flight)![0];
      const forged: SegmentHeader = { ...s.header, n: s.header.n - 1 };
      const ok = verifyHeader(forged, s.signature, d.drones[s.header.drone].publicKey);
      document.querySelector<HTMLElement>(`.seg[data-flight="${CSS.escape(flight)}"][data-i="0"] .sig`)!.innerHTML = tag(ok, ok ? "valid" : "invalid after edit");
      btn.textContent = ok ? "Edit went unnoticed?!" : "Edited · signature broken";
      btn.disabled = true;
    }),
  );
}

/* ---------------- investigator ---------------- */

let invArena: ArenaHandle | undefined;
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
      const rules = [...new Set(r.verdict.findings.map((f) => f.rule))];
      const dec = r.recs.filter((x) => x.k === "DECISION");
      $("invOut").innerHTML = `<div class="inv-grid">
        <div id="invView"></div>
        <div class="inv-side">
          <div class="kicker">Opened ${r.segments} sealed segments · ${r.recs.length} records</div>
          <div>${r.errors.length ? tag(false, "record problems") : tag(true, "every segment matches its drone-signed header")}</div>
          <div class="verdict-big ${r.verdict.breach ? "bad" : "ok"}">${r.verdict.breach ? `Breach: ${rules.map((x) => x.slice(0, 2)).join(" + ")}` : "No rule broken"}</div>
          <ul class="findings">${r.verdict.findings.map((f) => `<li><b>${esc(ruleName(f.rule))}</b>${f.seq !== undefined ? ` · record #${f.seq}` : ""}<br>${esc(f.detail)}</li>`).join("")}</ul>
          <div><b>Gate:</b> ${dec.map((x) => `${x.act} ${x.ok ? "ALLOW" : "DENY"}`).join(" · ") || "no answer (link lost)"}</div>
          <div class="kicker">Top-down</div>
          ${r.permit ? drawFlight(r.recs, r.permit, r.verdict) : ""}
        </div>
      </div>`;
      invArena?.dispose();
      if (r.permit) invArena = mountArena($("invView"), r.recs as Rec[], r.permit, r.verdict, { autoplay: true, compact: true });
    } catch (err) {
      $("invOut").innerHTML = `<p class="verdict paid">Could not open: ${esc(err instanceof Error ? err.message : String(err))}</p>`;
    }
  });
}

/* ---------------- settlement, fraud, inbox ---------------- */

function renderBatches(d: Data) {
  const rows = d.batches.map(
    (b) => `<tr>
      <td><b>#${b.index}</b></td>
      <td>${b.inboxEnd - b.inboxStart} posts <span class="muted">(${b.inboxStart + 1}–${b.inboxEnd})</span></td>
      <td>${b.withdrawals.length ? b.withdrawals.map((w) => `${qor(w.amount)} QOR → <span class="mono">${short(w.recipient, 8)}</span> ${w.index !== undefined && d.withdrawalsExecuted?.[w.index] ? tag(true, "paid") : ""}`).join("<br>") : '<span class="muted">—</span>'}</td>
      <td class="bstatus" data-b="${b.index}">${b.status === "finalized" ? tag(true, "finalized") : tag("warn", b.status)}</td>
      <td><button class="btn" data-receipt="${b.index}">Verify receipt</button><ul class="checks" id="r${b.index}"></ul></td>
    </tr>`,
  );
  $("batches").innerHTML = `<div class="scroll"><table class="table"><thead><tr><th>Batch</th><th>Inbox</th><th>Withdrawals</th><th>Status</th><th>Settlement receipt</th></tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
  $("batches").querySelectorAll<HTMLButtonElement>("button[data-receipt]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const i = Number(btn.dataset.receipt);
      btn.disabled = true;
      btn.textContent = "Checking QoreChain…";
      try {
        const receipt = await buildSettlementReceipt(client, d.rollup.rollupId, i);
        const v = await verifySettlementReceipt(receipt, { client });
        $(`r${i}`).innerHTML = Object.entries(v.checks ?? {}).map(([k, ok]) => `<li class="${ok ? "" : "no"}">${esc(k)}</li>`).join("");
        btn.textContent = v.valid ? `Valid · height ${v.anchor?.mainChainHeight?.toLocaleString()} · ${receipt.algorithm}` : "Not valid";
      } catch (e) {
        btn.textContent = `Could not check: ${e instanceof Error ? e.message : e}`;
      }
    }),
  );
}

function renderFraud(d: Data) {
  const rows = (d.fraud ?? []).map(
    (f) => `<tr><td><b>#${esc(f.batch)}</b></td><td class="mono">${esc(short(f.tx, 10))}</td><td>${f.height.toLocaleString()}</td><td>${qor(f.slashed.replace("uqor", ""))} QOR slashed · ${qor(f.burned.replace("uqor", ""))} burned</td><td class="mono">${esc(short(f.challenger, 10))}</td></tr>`,
  );
  $("fraudList").innerHTML = rows.length
    ? `<div class="scroll"><table class="table"><thead><tr><th>Batch</th><th>Tx</th><th>Height</th><th>Penalty</th><th>Challenger</th></tr></thead><tbody>${rows.join("")}</tbody></table></div>
       <p class="note">A second, bonded submitter published a batch whose withdrawals root paid the whole claims pool to itself. QoreChain re-executed it, upheld the fraud proof and rolled the inbox back; our watchtower found the same fraud, rewound, and the honest batch replaced it.</p>`
    : `<p class="muted">None so far.</p>`;
}

function renderPosts(d: Data) {
  const rows = d.posts.map((p) => `<tr><td>${p.seq}</td><td>#${p.batch}</td><td>${esc(p.kind)}</td><td class="mono">${esc(short(p.poster.replace("deposit:", ""), 10))}</td><td class="mono">${esc(p.detail)}</td></tr>`);
  $("posts").innerHTML = `<div class="scroll"><table class="table"><thead><tr><th>#</th><th>Batch</th><th>Kind</th><th>Poster</th><th>Detail</th></tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
}

/** Live status from QoreChain: rollup, latest batch, and each batch's challenge window. */
async function live(d: Data) {
  const tick = async () => {
    const [r, tip] = await Promise.all([client.rest.getRollup(d.rollup.rollupId), client.getChainTip()]);
    const latest = await client.rest.getLatestBatch(d.rollup.rollupId);
    $("live").className = "pill on";
    $("live").textContent = `● live · batch #${latest.batchIndex} · h ${tip.height.toLocaleString()}`;
    const win = r.challengeWindowSec ?? 3600;
    for (const b of d.batches) {
      const cell = document.querySelector<HTMLElement>(`.bstatus[data-b="${b.index}"]`);
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
