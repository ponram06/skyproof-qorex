import "./polyfill";
import { buildSettlementReceipt, createRdkClient, verifySettlementReceipt } from "@qorechain/rdk";
import { parseHeaderPost, verifyHeader, type SegmentHeader } from "./verify";
import { drawFlight, openFlight, type InvestigatorData } from "./investigator";
import { mountArena, type ArenaHandle, type Rec } from "./arena";
import { simulate, SIM_SCENARIOS, type SimScenario } from "../../rollup/src/sim/sim";
import { DEMO_PERMIT } from "../../rollup/src/flight/scenarios";
import { judge, type Verdict } from "../../rollup/src/rules";
import { balanceUqor, CLAIM_FEE_QOR, createWallet, fileClaim, forgetWallet, loadWallet, restoreWallet, type ClaimWallet } from "./wallet";

/* ================= data ================= */

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

interface Segment { header: SegmentHeader; signature: Uint8Array; batch: number; seq: number; sigOk: boolean; chainOk: boolean; sealed: boolean }
interface Flight { id: string; name: string; segs: Segment[]; intact: boolean; records: number; claim?: Data["claims"][number] }

/* ================= words ================= */

const SCENARIO: Record<SimScenario, { name: string; hint: string; about: string }> = {
  normal: { name: "Normal delivery", hint: "By the book", about: "The drone asks before every move and gets a “Yes” each time." },
  people_below: { name: "Someone below", hint: "Drone waits", about: "A person is under the drop point. The drone hears “No”, waits, and drops once they leave." },
  link_lost: { name: "Signal lost", hint: "Lands safely", about: "The drone loses its safety check. It doesn't guess; it lands where it is." },
  cheating: { name: "Operator ignores “No”", hint: "Breaks a rule", about: "A person is under the drop point. The safety check says “No”. The operator drops anyway." },
  unapproved: { name: "Never asked", hint: "Breaks a rule", about: "The operator drops the parcel without asking first." },
  shortcut: { name: "No-fly shortcut", hint: "Breaks a rule", about: "The operator cuts straight through a no-fly zone." },
  altitude: { name: "Too high", hint: "Breaks a rule", about: "The operator cruises above the 120 m limit." },
  wind: { name: "Too windy", hint: "Breaks a rule", about: "The safety check says it's too windy. The operator takes off anyway." },
};
const SAFE: SimScenario[] = ["normal", "people_below", "link_lost"];
const RULES: [string, string][] = [
  ["B1_GEOFENCE", "Stay in the allowed area"],
  ["B2_ALTITUDE", "Stay under 120 m"],
  ["B3_UNAPPROVED_ACTION", "Ask before acting"],
  ["B4_OVERRIDE", "Respect a “No”"],
  ["B5_RECORD_BROKEN", "Keep the full record"],
  ["B6_WIND", "No take-off in high wind"],
];
const RULE = Object.fromEntries(RULES) as Record<string, string>;
const FLIGHT_NAME: Record<string, string> = {
  override: "Operator overrode the safety check",
  normal: "Normal delivery",
  people_below: "Person below, drone waited",
  cheating: "Person below, operator dropped anyway",
};

/* ================= helpers ================= */

const client = createRdkClient({ network: "testnet", endpoints: { rest: `${location.origin}/api/rest`, rpc: `${location.origin}/api/rpc` } });
const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector<T>(sel)!;
const $$ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => [...root.querySelectorAll<T>(sel)];
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const qor = (uqor: string | number) => (Number(String(uqor).replace("uqor", "")) / 1e6).toLocaleString(undefined, { maximumFractionDigits: 2 });
const short = (s: string, n = 8) => (s.length > 2 * n + 1 ? `${s.slice(0, n)}…${s.slice(-6)}` : s);
const badge = (tone: "ok" | "bad" | "warn" | "plain", text: string) => `<span class="badge ${tone}">${esc(text)}</span>`;
const brokenRules = (v?: Verdict) => [...new Set(v?.findings.map((f) => f.rule) ?? [])];
const ruleList = (broken: string[]) => RULES.map(([k, t]) => `<span class="${broken.includes(k) ? "x" : ""}">${broken.includes(k) ? "✕" : "✓"} ${esc(t)}</span>`).join("");

let data: Data;
let flights: Flight[] = [];
let arenas: ArenaHandle[] = [];
const disposeArenas = () => {
  arenas.forEach((a) => a.dispose());
  arenas = [];
};

function buildFlights(d: Data): Flight[] {
  const by = new Map<string, Segment[]>();
  const bodies = new Set(Object.keys(d.bodies ?? {}));
  for (const h of d.headers) {
    const p = parseHeaderPost(h.post);
    const list = by.get(p.header.flight) ?? by.set(p.header.flight, []).get(p.header.flight)!;
    list.push({ ...p, batch: h.batch, seq: h.seq, sigOk: false, chainOk: false, sealed: bodies.has(p.header.body) });
  }
  return [...by.entries()].map(([id, segs]) => {
    segs.sort((a, b) => a.header.idx - b.header.idx);
    const drone = d.drones[segs[0].header.drone];
    let prev = "00".repeat(32);
    for (const s of segs) {
      s.sigOk = !!drone && verifyHeader(s.header, s.signature, drone.publicKey);
      s.chainOk = s.header.prev === prev;
      prev = s.header.head;
    }
    const key = Object.keys(FLIGHT_NAME).find((k) => id.includes(`-${k}-`));
    return {
      id,
      name: key ? FLIGHT_NAME[key] : id,
      segs,
      intact: segs.every((s) => s.sigOk && s.chainOk && s.sealed),
      records: segs.reduce((n, s) => n + s.header.n, 0),
      claim: d.claims.find((c) => c.flight === id),
    };
  });
}

const paidTotal = (d: Data) =>
  d.batches.flatMap((b) => b.withdrawals).filter((w) => w.index !== undefined && d.withdrawalsExecuted?.[w.index]).reduce((s, w) => s + Number(w.amount), 0);

function outcome(c?: Flight["claim"]) {
  if (!c) return { tone: "plain" as const, label: "No claim" };
  if (c.status === "paid") return { tone: "bad" as const, label: "Rule broken · 5 QOR paid" };
  if (c.status === "rejected") return { tone: "ok" as const, label: "Safe · claim rejected" };
  return { tone: "warn" as const, label: "Claim open" };
}

/* ================= pages ================= */

function home() {
  const stats: [string, string][] = [
    [String(flights.length), "real flights on chain"],
    [`${qor(paidTotal(data))} QOR`, "paid to victims"],
    [String(data.fraud?.length ?? 0), "cheater caught"],
    [String(data.batches.length), "batches settled"],
  ];
  return `
  <section class="hero wrap">
    <div class="eyebrow"><span class="pulse"></span>Live on QoreChain testnet</div>
    <h1>Every drone flight,<br /><span>on the record.</span></h1>
    <p class="sub">Drones log every move to a record nobody can edit. Break a safety rule, and the victim is paid automatically.</p>
    <div class="actions">
      <button class="btn primary" data-scroll="demo">Try the demo</button>
      <a class="btn" href="#/flights">See real flights</a>
    </div>
    <div class="stats">${stats.map(([v, k]) => `<div><b>${esc(v)}</b><span>${esc(k)}</span></div>`).join("")}</div>
  </section>

  <section class="wrap section" id="demo">
    <div class="head"><h2>Try it</h2><p>Pick a flight and watch what happens.</p></div>
    <div class="demo">
      <div class="picker" role="tablist" aria-label="Flight">
        ${SIM_SCENARIOS.map((s) => `<button role="tab" data-s="${s}" class="${SAFE.includes(s) ? "safe" : "risky"}"><b>${esc(SCENARIO[s].name)}</b><span>${esc(SCENARIO[s].hint)}</span></button>`).join("")}
      </div>
      <div class="stage">
        <div id="result" class="result" aria-live="polite"></div>
        <div id="simView" class="view"></div>
        <div id="ruleList" class="rules"></div>
      </div>
    </div>
  </section>

  <section class="wrap section">
    <div class="head"><h2>How it works</h2></div>
    <div class="steps">
      ${[
        ["1", "Ask", "The drone asks permission before every take-off, drop and landing."],
        ["2", "Lock", "Each flight is sealed and saved on QoreChain. Nobody can edit it."],
        ["3", "Pay", "Broke a rule? The victim is paid from the operator's deposit."],
      ]
        .map(([n, t, p]) => `<div class="card step"><span class="n">${n}</span><h3>${t}</h3><p>${p}</p></div>`)
        .join("")}
    </div>
  </section>

  <section class="wrap section">
    <div class="head"><h2>Who it's for</h2></div>
    <div class="who">
      ${[
        ["People on the ground", "Get paid when a drone breaks the rules, without a court case.", "#/claims", "See claims"],
        ["Drone operators", "Prove every flight was safe, with a record nobody can doubt.", "#/flights", "See flights"],
        ["Insurers and investigators", "Open the sealed record and get a decision in seconds.", "#/investigate", "Open a record"],
      ]
        .map(([t, p, href, cta]) => `<a class="card who-card" href="${href}"><h3>${t}</h3><p>${p}</p><span class="more">${cta} →</span></a>`)
        .join("")}
    </div>
  </section>`;
}

function homeReady() {
  $$<HTMLButtonElement>("[data-scroll]").forEach((b) => (b.onclick = () => document.getElementById(b.dataset.scroll!)?.scrollIntoView({ behavior: "smooth" })));
  const fly = (s: SimScenario) => {
    $$<HTMLButtonElement>(".picker button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.s === s)));
    const recs = simulate({ scenario: s, flight: `demo-${s}`, drone: "SKY-001", permit: DEMO_PERMIT, permitHash: "demo", seed: 7 + SIM_SCENARIOS.indexOf(s) });
    const verdict = judge(recs, DEMO_PERMIT);
    let shown = false;
    const reveal = () => {
      if (shown) return;
      shown = true;
      $("#result").className = `result ${verdict.breach ? "bad" : "ok"}`;
      $("#result").innerHTML = `<span class="icon">${verdict.breach ? "✕" : "✓"}</span>
        <div><b>${verdict.breach ? "Rule broken. The victim gets paid." : "Safe flight. No payout needed."}</b><span>${esc(SCENARIO[s].about)}</span></div>`;
      $("#ruleList").innerHTML = ruleList(brokenRules(verdict));
    };
    $("#result").className = "result wait";
    $("#result").innerHTML = `<span class="icon"><i class="spin"></i></span>
      <div><b>Watching the flight…</b><span>${esc(SCENARIO[s].about)}</span></div><button class="btn sm" id="skip">Show result</button>`;
    $("#skip").onclick = reveal;
    $("#ruleList").innerHTML = ruleList([]).replace(/✓/g, "·");
    disposeArenas();
    arenas.push(mountArena($("#simView"), recs as Rec[], DEMO_PERMIT, verdict, { autoplay: true, onBreach: reveal, onEnd: reveal }));
  };
  $$<HTMLButtonElement>(".picker button").forEach((b) => (b.onclick = () => fly(b.dataset.s as SimScenario)));
  fly("people_below");
}

function flightsPage() {
  return `
  <section class="wrap page">
    <div class="head"><h1>Flights</h1><p>Real flights saved on QoreChain. Open one to check it.</p></div>
    <div class="list">
      ${flights
        .map((f) => {
          const o = outcome(f.claim);
          const broken = brokenRules(f.claim?.verdict);
          return `<details class="card row-card" data-flight="${esc(f.id)}">
          <summary>
            <div class="grow"><b>${esc(f.name)}</b><span class="muted">${f.records} records · ${f.segs.length} signed parts</span></div>
            <div class="badges">${badge(f.intact ? "ok" : "bad", f.intact ? "Record intact" : "Record broken")}${badge(o.tone, o.label)}</div>
            <span class="chev" aria-hidden="true"></span>
          </summary>
          <div class="body">
            <div class="kv">
              <div><span>Claim</span><b>“${esc(f.claim?.note ?? "None")}”</b></div>
              <div><span>Decision</span><b>${broken.length ? `Broke: ${broken.map((r) => esc(RULE[r] ?? r)).join(", ")}` : f.claim ? "No rule broken" : "—"}</b></div>
            </div>
            <div><a class="btn sm" href="#/claims/${encodeURIComponent(f.id)}">Hurt by this flight? File a claim</a></div>
            <div class="tamper">
              <button class="btn" data-tamper="${esc(f.id)}">Try to edit this record</button>
              <span class="msg muted">Removes one moment from the record in your browser, then re-checks the drone's signature.</span>
            </div>
            <div class="scroll"><table class="table">
              <thead><tr><th>Part</th><th>Records</th><th>Drone signature</th><th>Linked</th><th>Sealed</th></tr></thead>
              <tbody>${f.segs
                .map(
                  (s, i) => `<tr><td>${s.header.idx + 1}</td><td>${s.header.n}</td><td data-sig="${i}">${badge(s.sigOk ? "ok" : "bad", s.sigOk ? "Valid" : "Invalid")}</td><td>${badge(s.chainOk ? "ok" : "bad", s.chainOk ? "Yes" : "No")}</td><td>${badge(s.sealed ? "ok" : "warn", s.sealed ? "Yes" : "Missing")}</td></tr>`,
                )
                .join("")}</tbody>
            </table></div>
            <p class="tiny mono muted">${esc(f.id)}</p>
          </div>
        </details>`;
        })
        .join("")}
    </div>
  </section>`;
}

function flightsReady() {
  const want = decodeURIComponent(location.hash.split("/")[2] ?? "");
  const target = want ? $$<HTMLDetailsElement>("details[data-flight]").find((d) => d.dataset.flight === want) : undefined;
  if (target) {
    target.open = true;
    requestAnimationFrame(() => target.scrollIntoView({ block: "start" }));
  }
  $$<HTMLButtonElement>("[data-tamper]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const f = flights.find((x) => x.id === btn.dataset.tamper)!;
      const s = f.segs[0];
      const ok = verifyHeader({ ...s.header, n: s.header.n - 1 }, s.signature, data.drones[s.header.drone].publicKey);
      const card = btn.closest(".body")!;
      $('[data-sig="0"]', card).innerHTML = badge(ok ? "ok" : "bad", ok ? "Valid" : "Invalid after edit");
      btn.disabled = true;
      btn.textContent = ok ? "Edit not detected" : "Edit caught";
      const msg = $(".msg", card);
      msg.className = `msg ${ok ? "" : "good"}`;
      msg.textContent = ok ? "The edit was not detected." : "The signature no longer matches. Any edit is caught instantly.";
    }),
  );
}

function claimsPage() {
  const rows = data.claims.map((c) => {
    const f = flights.find((x) => x.id === c.flight);
    const broken = brokenRules(c.verdict);
    const tone = c.status === "paid" ? "bad" : c.status === "rejected" ? "ok" : "warn";
    return `<tr data-victim="${esc(c.victim)}">
      <td><b>“${esc(c.note)}”</b><span class="muted block">by ${esc(short(c.victim))}</span></td>
      <td><a class="link" href="#/flights/${encodeURIComponent(c.flight)}">${esc(f?.name ?? c.flight)}</a></td>
      <td>${badge(tone, c.status === "paid" ? "Paid 5 QOR" : c.status === "rejected" ? "Rejected" : "Open")}${broken.length ? `<span class="muted block">${broken.map((r) => esc(RULE[r] ?? r)).join(", ")}</span>` : ""}</td>
    </tr>`;
  });
  return `
  <section class="wrap page">
    <div class="head"><h1>Claims</h1><p>Hurt by a drone? File a claim. The watchtower opens the sealed record and checks six rules. If one was broken, you are paid automatically.</p></div>
    <section class="card file" id="file" aria-labelledby="fileTitle">
      <div class="file-head"><h2 id="fileTitle">File a claim</h2><span class="muted">Signed with a quantum-safe key (ML-DSA-87), straight from this page.</span></div>
      <div id="fileBox"></div>
    </section>
    <form class="card lookup" id="lookup">
      <label for="addr"><b>Check my claim</b><span class="muted">Enter your QoreChain address (qor1…)</span></label>
      <div class="lookup-row"><input id="addr" placeholder="qor1…" autocomplete="off" spellcheck="false" /><button class="btn primary">Check</button></div>
      <div id="lookupOut" aria-live="polite"></div>
    </form>
    <div class="card flush"><div class="scroll"><table class="table">
      <thead><tr><th>Claim</th><th>Flight</th><th>Decision</th></tr></thead>
      <tbody>${rows.join("")}</tbody>
    </table></div></div>
    <h2 class="sub-h">The six rules</h2>
    <div class="rule-grid">${RULES.map(([, t], i) => `<div class="card rule"><span class="n">${i + 1}</span>${esc(t)}</div>`).join("")}</div>
  </section>`;
}

let walletPoll: ReturnType<typeof setInterval> | undefined;

function claimsReady() {
  const want = decodeURIComponent(location.hash.split("/")[2] ?? "");
  renderFileBox(loadWallet(), flights.some((f) => f.id === want) ? want : undefined);
  if (want) requestAnimationFrame(() => $("#file").scrollIntoView({ block: "start" }));
  $("#lookup").addEventListener("submit", async (e) => {
    e.preventDefault();
    const addr = $<HTMLInputElement>("#addr").value.trim().toLowerCase();
    const out = $("#lookupOut");
    $$("tr[data-victim]").forEach((tr) => tr.classList.remove("hit"));
    if (!/^qor1[02-9ac-hj-np-z]{20,90}$/.test(addr)) {
      out.innerHTML = `<p class="alert">That doesn't look like a QoreChain address. It starts with <b>qor1</b>.</p>`;
      return;
    }
    const mine = data.claims.filter((c) => c.victim === addr);
    $$(`tr[data-victim="${CSS.escape(addr)}"]`).forEach((tr) => tr.classList.add("hit"));
    const paid = mine.filter((c) => c.status === "paid").length;
    let balance = "";
    try {
      const r = await fetch(`/api/rest/cosmos/bank/v1beta1/balances/${addr}`).then((x) => x.json());
      const q = (r.balances ?? []).find((b: { denom: string }) => b.denom === "uqor");
      balance = ` Your balance on QoreChain right now: <b>${qor(q?.amount ?? 0)} QOR</b>.`;
    } catch {
      /* the balance is a nice-to-have */
    }
    out.innerHTML = mine.length
      ? `<p class="found ok">${mine.length} claim${mine.length > 1 ? "s" : ""} found: <b>${paid} paid</b>, ${mine.length - paid} rejected. They are highlighted below.${balance}</p>`
      : `<p class="found">No judged claims for this address yet. A new claim shows here after the watchtower's next check.${balance}</p>`;
  });
}

/* ---------- file a claim (wallet.ts) ---------- */

function renderFileBox(w: ClaimWallet | undefined, flight?: string) {
  clearInterval(walletPoll);
  const box = $("#fileBox");
  if (!w) {
    box.innerHTML = `
      <ol class="file-steps">
        <li class="on"><b>Get a claim wallet.</b> It's created in this browser and is where your payout goes.</li>
        <li><b>Add a little test QOR</b> (${CLAIM_FEE_QOR} QOR) for the network fee.</li>
        <li><b>Pick the flight and say what happened.</b></li>
      </ol>
      <div class="file-actions"><button class="btn primary" id="wNew">Create my claim wallet</button><button class="btn" id="wHave">I have a recovery phrase</button></div>
      <form id="wRestore" class="file-restore" hidden>
        <label for="wWords" class="muted">Your 24 recovery words</label>
        <textarea id="wWords" rows="2" autocomplete="off" spellcheck="false"></textarea>
        <button class="btn">Restore</button>
      </form>
      <div id="fileOut" aria-live="polite"></div>`;
    $("#wNew").onclick = async () => {
      $<HTMLButtonElement>("#wNew").disabled = true;
      renderFileBox(await createWallet(), flight);
    };
    $("#wHave").onclick = () => ($("#wRestore").hidden = false);
    $("#wRestore").addEventListener("submit", async (e) => {
      e.preventDefault();
      try {
        renderFileBox(await restoreWallet($<HTMLTextAreaElement>("#wWords").value), flight);
      } catch (err) {
        $("#fileOut").innerHTML = `<p class="alert">${esc(err instanceof Error ? err.message : String(err))}</p>`;
      }
    });
    return;
  }
  const options = flights.map((f) => `<option value="${esc(f.id)}"${f.id === flight ? " selected" : ""}>${esc(f.name)}</option>`).join("");
  box.innerHTML = `
    <div class="wallet">
      <div class="grow"><span class="muted tiny">Your claim wallet (payouts go here)</span><b class="mono" id="wAddr">${esc(w.address)}</b></div>
      <button class="btn sm" id="wCopy">Copy</button>
      <span class="badge plain" id="wBal">Checking…</span>
    </div>
    <p class="fund" id="wFund" hidden>Send at least <b>${CLAIM_FEE_QOR} test QOR</b> to this address for the network fee. This page checks every few seconds.</p>
    <form id="claimForm" class="claim-form">
      <label><span>Which flight?</span><select id="cFlight">${options}</select></label>
      <label><span>What happened?</span><textarea id="cNote" rows="3" maxlength="280" required placeholder="e.g. The parcel fell on my car near the drop point."></textarea></label>
      <div class="file-actions"><button class="btn primary" id="cSend" disabled>Sign and file claim</button><span class="muted tiny">Network fee about 0.04 QOR</span></div>
    </form>
    <div id="fileOut" aria-live="polite"></div>
    <details class="wallet-more">
      <summary>Recovery phrase and wallet options</summary>
      <p class="muted tiny">Anyone with these words controls this wallet and its payouts. Write them down. This is a testnet wallet; don't keep real funds in it.</p>
      <p class="mono words" id="wWordsShow" hidden>${esc(w.mnemonic)}</p>
      <div class="file-actions"><button class="btn sm" id="wShow">Show words</button><button class="btn sm" id="wForget">Remove from this browser</button></div>
    </details>`;
  let funded = false;
  const refresh = async () => {
    try {
      const b = await balanceUqor(w.address);
      funded = Number(b) / 1e6 >= CLAIM_FEE_QOR / 2;
      $("#wBal").className = `badge ${funded ? "ok" : "warn"}`;
      $("#wBal").textContent = `${qor(b.toString())} QOR`;
      $("#wFund").hidden = funded;
      $<HTMLButtonElement>("#cSend").disabled = !funded;
    } catch {
      $("#wBal").textContent = "Balance unavailable";
    }
  };
  refresh();
  walletPoll = setInterval(() => {
    if (!document.body.contains(box)) return clearInterval(walletPoll);
    if (!funded) refresh();
  }, 8000);
  $("#wCopy").onclick = async () => {
    try {
      await navigator.clipboard.writeText(w.address);
      $("#wCopy").textContent = "Copied";
    } catch {
      getSelection()?.selectAllChildren($("#wAddr"));
    }
  };
  $("#wShow").onclick = () => {
    const p = $("#wWordsShow");
    p.hidden = !p.hidden;
    $("#wShow").textContent = p.hidden ? "Show words" : "Hide words";
  };
  $("#wForget").onclick = () => {
    if ($("#wForget").dataset.sure !== "1") {
      $("#wForget").dataset.sure = "1";
      $("#wForget").textContent = "Click again: I saved my words";
      return;
    }
    forgetWallet();
    renderFileBox(undefined, flight);
  };
  $("#claimForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const flightId = $<HTMLSelectElement>("#cFlight").value;
    const note = $<HTMLTextAreaElement>("#cNote").value.trim();
    const out = $("#fileOut");
    if (!note) return;
    const send = $<HTMLButtonElement>("#cSend");
    send.disabled = true;
    try {
      const r = await fileClaim(client, w, { rollupId: data.rollup.rollupId, flight: flightId, note }, (step) => {
        out.innerHTML = `<p class="found"><i class="spin inline"></i>${esc(step)}</p>`;
      });
      const f = flights.find((x) => x.id === flightId);
      out.innerHTML = `<div class="result ok"><span class="icon">✓</span><div><b>Claim filed on QoreChain.</b>
        <span>For “${esc(f?.name ?? flightId)}” · block ${r.height.toLocaleString()} · fee ${qor(r.feeUqor.toString())} QOR</span>
        <span class="mono block">${esc(r.txhash)}</span></div></div>
        <p class="muted tiny next">Next: the watchtower opens the sealed record and checks the six rules. If a rule was broken, 5 QOR is paid to your claim wallet. Check back with your address below.</p>`;
      $<HTMLTextAreaElement>("#cNote").value = "";
      $<HTMLInputElement>("#addr").value = w.address;
      refresh();
    } catch (err) {
      out.innerHTML = `<p class="alert">${esc(err instanceof Error ? err.message : String(err))}</p>`;
    } finally {
      send.disabled = !funded;
    }
  });
}

function proofPage() {
  const r = data.rollup;
  const paid = Object.entries(data.withdrawalsExecuted ?? {});
  return `
  <section class="wrap page">
    <div class="head"><h1>Proof</h1><p>For judges and developers. Everything here can be checked live against QoreChain.</p></div>

    <div class="grid-3">
      <div class="card fact"><span>Rollup</span><b>${esc(r.rollupId)}</b><em>${badge(r.status === "active" ? "ok" : "warn", r.status)}</em></div>
      <div class="card fact"><span>Settlement</span><b>${esc(r.settlementMode)}</b><em class="muted">${esc(r.executionVm)} · ${esc(r.sequencing)} sequencing</em></div>
      <div class="card fact"><span>Post-quantum</span><b>ML-DSA-87 · ML-KEM-1024</b><em class="muted">Signed records, sealed bodies, registered PQC keys</em></div>
    </div>

    <h2 class="sub-h">Batches</h2>
    <div class="card flush"><div class="scroll"><table class="table">
      <thead><tr><th>Batch</th><th>Posts</th><th>Payouts</th><th>Status</th><th>Receipt</th></tr></thead>
      <tbody>${data.batches
        .map(
          (b) => `<tr>
        <td><b>#${b.index}</b></td>
        <td>${b.inboxEnd - b.inboxStart}</td>
        <td>${b.withdrawals.length ? b.withdrawals.map((w) => `${qor(w.amount)} QOR → <span class="mono">${short(w.recipient)}</span>`).join("<br>") : '<span class="muted">—</span>'}</td>
        <td class="bstatus" data-b="${b.index}">${badge(b.status === "finalized" ? "ok" : "warn", b.status)}</td>
        <td><button class="btn sm" data-receipt="${b.index}">Verify</button><div class="checks tiny muted" id="r${b.index}"></div></td>
      </tr>`,
        )
        .join("")}</tbody>
    </table></div></div>

    <h2 class="sub-h">Payouts executed on QoreChain</h2>
    <div class="card flush"><div class="scroll"><table class="table"><thead><tr><th>Withdrawal</th><th>Transaction</th></tr></thead>
      <tbody>${paid.map(([i, tx]) => `<tr><td>#${esc(i)}</td><td class="mono">${esc(tx)}</td></tr>`).join("") || `<tr><td colspan="2" class="muted">None yet</td></tr>`}</tbody></table></div></div>

    <h2 class="sub-h">Fraud caught</h2>
    <div class="card flush"><div class="scroll"><table class="table"><thead><tr><th>Batch</th><th>Penalty</th><th>Transaction</th></tr></thead>
      <tbody>${(data.fraud ?? []).map((f) => `<tr><td>#${esc(f.batch)}</td><td>${qor(f.slashed)} QOR slashed, ${qor(f.burned)} burned</td><td class="mono">${esc(short(f.tx, 12))}</td></tr>`).join("") || `<tr><td colspan="3" class="muted">None</td></tr>`}</tbody></table></div></div>
    <p class="muted note">A dishonest submitter posted a batch paying itself. QoreChain re-executed it, upheld the fraud proof and slashed its bond. The honest batch replaced it.</p>

    <details class="card raw"><summary>All ${data.posts.length} rollup posts</summary><div class="scroll"><table class="table">
      <thead><tr><th>#</th><th>Batch</th><th>Kind</th><th>Detail</th></tr></thead>
      <tbody>${data.posts.map((p) => `<tr><td>${p.seq}</td><td>${p.batch}</td><td>${esc(p.kind)}</td><td class="mono">${esc(p.detail)}</td></tr>`).join("")}</tbody>
    </table></div></details>
  </section>`;
}

function proofReady() {
  $$<HTMLButtonElement>("[data-receipt]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const i = Number(btn.dataset.receipt);
      btn.disabled = true;
      btn.textContent = "Checking…";
      try {
        const receipt = await buildSettlementReceipt(client, data.rollup.rollupId, i);
        const v = await verifySettlementReceipt(receipt, { client });
        const checks = Object.entries(v.checks ?? {});
        btn.textContent = v.valid ? "✓ Valid" : "Not valid";
        btn.classList.toggle("done", v.valid);
        $(`#r${i}`).textContent = `${checks.filter(([, ok]) => ok).length}/${checks.length} checks · block ${v.anchor?.mainChainHeight?.toLocaleString() ?? "?"}`;
      } catch (e) {
        btn.textContent = "Couldn't check";
        $(`#r${i}`).textContent = e instanceof Error ? e.message : String(e);
      }
    }),
  );
}

function investigatePage() {
  return `
  <section class="wrap page">
    <div class="head"><h1>Investigate</h1><p>Open a sealed flight record with the investigator's key. The key never leaves your browser.</p></div>
    <div class="card form">
      <label><span>1. Key file</span><input type="file" id="invKey" accept=".json" /></label>
      <label><span>2. Flight</span><select id="invFlight">${flights.map((f) => `<option value="${esc(f.id)}">${esc(f.name)}</option>`).join("")}</select></label>
      <button class="btn primary" id="invOpen" disabled>3. Open record</button>
    </div>
    <p class="muted tiny">No key? Create the demo key with <code>npm run investigator-key</code> in <code>rollup/</code>. Without it, the record is unreadable.</p>
    <div id="invOut"></div>
  </section>`;
}

function investigateReady() {
  let key: { address: string; seed: string } | undefined;
  const btn = $<HTMLButtonElement>("#invOpen");
  const out = $("#invOut");
  $<HTMLInputElement>("#invKey").addEventListener("change", async (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    try {
      const k = JSON.parse(await file.text());
      key = { address: k.address, seed: k.mlkem1024Seed };
      btn.disabled = !key.address || !key.seed;
      out.innerHTML = btn.disabled ? `<p class="alert">That file has no investigator key.</p>` : "";
    } catch {
      out.innerHTML = `<p class="alert">That isn't a key file.</p>`;
    }
  });
  btn.addEventListener("click", () => {
    if (!key) return;
    try {
      const r = openFlight(data as unknown as InvestigatorData, $<HTMLSelectElement>("#invFlight").value, key);
      out.innerHTML = `<div class="inv">
        <div id="invView" class="view"></div>
        <div class="card inv-side">
          <div class="result ${r.verdict.breach ? "bad" : "ok"}"><span class="icon">${r.verdict.breach ? "✕" : "✓"}</span>
            <div><b>${r.verdict.breach ? "Rule broken" : "No rule broken"}</b><span>${r.segments} parts opened · ${r.recs.length} records${r.errors.length ? " · problems found" : " · all match the signed record"}</span></div></div>
          <div class="rules">${ruleList(brokenRules(r.verdict))}</div>
          ${r.permit ? `<div class="mapbox">${drawFlight(r.recs, r.permit, r.verdict)}</div>` : ""}
        </div>
      </div>`;
      disposeArenas();
      if (r.permit) arenas.push(mountArena($("#invView"), r.recs as Rec[], r.permit, r.verdict, { autoplay: true, compact: true }));
    } catch (err) {
      out.innerHTML = `<p class="alert">Couldn't open: ${esc(err instanceof Error ? err.message : String(err))}</p>`;
    }
  });
}

/* ================= router + live status ================= */

const pages: Record<string, [() => string, (() => void)?]> = {
  "": [home, homeReady],
  flights: [flightsPage, flightsReady],
  claims: [claimsPage, claimsReady],
  proof: [proofPage, proofReady],
  investigate: [investigatePage, investigateReady],
};

function route() {
  const name = location.hash.replace(/^#\/?/, "").split("/")[0];
  const page = name in pages ? name : "";
  const [render, ready] = pages[page];
  disposeArenas();
  $("#app").innerHTML = render();
  ready?.();
  $$(".links a").forEach((a) => a.classList.toggle("on", a.dataset.r === page));
  document.body.classList.remove("menu-open");
  $("#menu").setAttribute("aria-expanded", "false");
  if (!location.hash.split("/")[2]) window.scrollTo(0, 0);
  refreshBatchCells().catch(() => undefined);
}

let chain: { tipTime: number; win: number } | undefined;
async function refreshBatchCells() {
  if (!chain || !document.querySelector(".bstatus")) return;
  for (const b of data.batches) {
    const cell = document.querySelector<HTMLElement>(`.bstatus[data-b="${b.index}"]`);
    if (!cell) continue;
    const view = await client.rest.getBatch(data.rollup.rollupId, b.index);
    const left = view.submittedTime + chain.win - chain.tipTime;
    cell.innerHTML = view.status === "finalized" ? badge("ok", "finalized") : badge("warn", left > 0 ? `final in ${Math.ceil(left / 60)} min` : view.status);
  }
}

async function live() {
  const tick = async () => {
    const [r, tip] = await Promise.all([client.rest.getRollup(data.rollup.rollupId), client.getChainTip()]);
    chain = { tipTime: tip.timeSecs, win: r.challengeWindowSec ?? 3600 };
    $("#live").className = "live on";
    $("#live").textContent = `Live · block ${tip.height.toLocaleString()}`;
    await refreshBatchCells();
  };
  try {
    await tick();
  } catch (e) {
    console.error("live status:", e);
    $("#live").textContent = "Offline · saved data";
  }
  setInterval(() => tick().catch(() => undefined), 20_000);
}

async function main() {
  $("#app").innerHTML = `<div class="wrap loading"><i class="spin"></i>Loading flights…</div>`;
  try {
    const res = await fetch("/skyproof.json", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
  } catch (e) {
    $("#app").innerHTML = `<div class="wrap loading"><p class="alert">Couldn't load the flight data (${esc(e instanceof Error ? e.message : String(e))}). Please refresh.</p></div>`;
    return;
  }
  flights = buildFlights(data);
  $("#generated").textContent = `Data from ${new Date(data.generatedAt).toLocaleDateString()}`;
  $("#menu").addEventListener("click", () => {
    const open = document.body.classList.toggle("menu-open");
    $("#menu").setAttribute("aria-expanded", String(open));
  });
  window.addEventListener("hashchange", route);
  route();
  live();
}

main();
