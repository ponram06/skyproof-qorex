import "./polyfill";
import { buildSettlementReceipt, createRdkClient, verifySettlementReceipt } from "@qorechain/rdk";
import { parseHeaderPost, verifyHeader, type SegmentHeader } from "./verify";
import { drawFlight, openFlight, type InvestigatorData } from "./investigator";
import { mountArena, type ArenaHandle, type Rec } from "./arena";
import { simulate, SIM_SCENARIOS, type SimScenario } from "../../rollup/src/sim/sim";
import { DEMO_PERMIT } from "../../rollup/src/flight/scenarios";
import { judge, type Verdict } from "../../rollup/src/rules";
import { balanceUqor, CLAIM_FUNDS_QOR, createWallet, fileClaim, fileFingerprint, forgetWallet, keysFromFile, loadWallet, postDecision, restoreWallet, type ClaimWallet, type SigningKeys } from "./wallet";

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
  claims: { flight: string; victim: string; note: string; status: string; verdict?: Verdict; deposit?: string; height?: number; when?: string; where?: string; evidence?: string; decision?: { approve: boolean; reason: string } }[];
  claimsPool?: { account: string; depositUqor: string; payoutUqor: string };
  insurer?: string;
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
      // the newest claim on this flight (a flight can be claimed by several people)
      claim: d.claims.filter((c) => c.flight === id).pop(),
    };
  });
}

const paidTotal = (d: Data) =>
  d.batches.flatMap((b) => b.withdrawals).filter((w) => w.index !== undefined && d.withdrawalsExecuted?.[w.index]).reduce((s, w) => s + Number(w.amount), 0);

function outcome(c?: Flight["claim"]) {
  if (!c) return { tone: "plain" as const, label: "No claim" };
  if (c.status === "paid") return c.decision ? { tone: "bad" as const, label: "Insurer approved · paid" } : { tone: "bad" as const, label: "Rule broken · 5 QOR paid" };
  if (c.status === "rejected") return { tone: "ok" as const, label: c.decision ? "Insurer rejected the claim" : "Safe · claim rejected" };
  if (c.status === "review") return { tone: "warn" as const, label: "With the insurer" };
  return { tone: "warn" as const, label: "Claim open" };
}

/** How a claim's status reads in the claims table. */
function claimBadge(c: Data["claims"][number]) {
  const back = BigInt(c.deposit ?? "0") > 0n ? " + deposit back" : "";
  if (c.status === "paid") return badge("bad", c.decision ? `Insurer approved · paid 5 QOR${back}` : `Paid 5 QOR${back}`);
  if (c.status === "rejected") return badge("ok", c.decision ? "Rejected by insurer · deposit kept" : "Rejected");
  if (c.status === "review") return badge("warn", "With the insurer");
  return badge("warn", "Open");
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
      <a class="btn primary" href="#/tour">Watch the guided demo</a>
      <button class="btn" data-scroll="demo">Try a flight yourself</button>
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
        ["Drone operators", "Prove every flight was safe, with a record nobody can doubt.", "#/operator", "Open the console"],
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
    return `<tr data-victim="${esc(c.victim)}">
      <td><b>“${esc(c.note)}”</b><span class="muted block">by ${esc(short(c.victim))}</span></td>
      <td><a class="link" href="#/flights/${encodeURIComponent(c.flight)}">${esc(f?.name ?? c.flight)}</a></td>
      <td>${claimBadge(c)}${broken.length ? `<span class="muted block">${broken.map((r) => esc(RULE[r] ?? r)).join(", ")}</span>` : ""}${c.decision ? `<span class="muted block">Insurer: “${esc(c.decision.reason)}”</span>` : ""}</td>
    </tr>`;
  });
  return `
  <section class="wrap page">
    <div class="head"><h1>Claims</h1><p>Hurt by a drone? File a claim with a 1 QOR deposit. The watchtower opens the sealed flight record and checks six rules. Rule broken: you're paid 5 QOR and get your deposit back. No rule broken: an insurer reviews your proof. A false claim loses its deposit.</p></div>
    <ol class="flow">
      <li><b>You file</b><span>What happened, when, where, a photo fingerprint, and a 1 QOR deposit</span></li>
      <li><b>Records checked</b><span>The watchtower reads the drone's signed log against six rules</span></li>
      <li><b>Rule broken: paid</b><span>5 QOR plus your 1 QOR back, automatically</span></li>
      <li><b>No rule broken: insurer</b><span>A person checks your proof. Approved: paid. False claim: deposit kept</span></li>
    </ol>
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
      ? `<p class="found ok">${mine.length} claim${mine.length > 1 ? "s" : ""} found: <b>${paid} paid</b>, ${mine.filter((c) => c.status === "review").length} with the insurer, ${mine.filter((c) => c.status === "rejected").length} rejected. They are highlighted below.${balance}</p>`
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
        <li><b>Add ${CLAIM_FUNDS_QOR} test QOR:</b> a 1 QOR refundable deposit plus the network fee.</li>
        <li><b>Pick the flight, say what happened, and add your proof.</b></li>
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
    <p class="fund" id="wFund" hidden>Send at least <b>${CLAIM_FUNDS_QOR} test QOR</b> to this address: a 1 QOR deposit (you get it back if your claim is right) plus the network fee. This page checks every few seconds.</p>
    <form id="claimForm" class="claim-form">
      <label><span>Which flight?</span><select id="cFlight">${options}</select></label>
      <label><span>What happened?</span><textarea id="cNote" rows="3" maxlength="280" required placeholder="e.g. The parcel fell on my car near the drop point."></textarea></label>
      <div class="two">
        <label><span>When?</span><input type="datetime-local" id="cWhen" /></label>
        <label><span>Where?</span><input id="cWhere" maxlength="200" placeholder="e.g. 12 Main St, near the park" /></label>
      </div>
      <label><span>Photo proof <em class="muted">(optional)</em></span><input type="file" id="cPhoto" accept="image/*" />
        <small class="muted">The photo stays on your device. Only its fingerprint (SHA-256) goes on chain, so when you show it to the insurer they can prove it is the same photo you filed.</small>
        <small class="mono" id="cPhotoHash"></small></label>
      <div class="file-actions"><button class="btn primary" id="cSend" disabled>Pay 1 QOR deposit and file claim</button><span class="muted tiny">Deposit refunded with your payout · fee about 0.05 QOR</span></div>
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
      funded = Number(b) / 1e6 >= CLAIM_FUNDS_QOR - 0.05;
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
  let evidence: string | undefined;
  $<HTMLInputElement>("#cPhoto").addEventListener("change", async (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    evidence = f ? await fileFingerprint(f) : undefined;
    $("#cPhotoHash").textContent = evidence ? `Fingerprint: ${evidence}` : "";
  });
  $("#claimForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const flightId = $<HTMLSelectElement>("#cFlight").value;
    const note = $<HTMLTextAreaElement>("#cNote").value.trim();
    const when = $<HTMLInputElement>("#cWhen").value;
    const where = $<HTMLInputElement>("#cWhere").value.trim();
    const out = $("#fileOut");
    if (!note) return;
    if (!data.claimsPool) {
      out.innerHTML = `<p class="alert">Claims are paused: the site's data has no claims pool yet.</p>`;
      return;
    }
    const send = $<HTMLButtonElement>("#cSend");
    send.disabled = true;
    try {
      const claim = { flight: flightId, note, ...(when ? { when } : {}), ...(where ? { where } : {}), ...(evidence ? { evidence } : {}) };
      const r = await fileClaim(client, w, { rollupId: data.rollup.rollupId, poolAccount: data.claimsPool.account, depositUqor: BigInt(data.claimsPool.depositUqor), claim }, (step) => {
        out.innerHTML = `<p class="found"><i class="spin inline"></i>${esc(step)}</p>`;
      });
      const f = flights.find((x) => x.id === flightId);
      out.innerHTML = `<div class="result ok"><span class="icon">✓</span><div><b>Claim filed on QoreChain, with your 1 QOR deposit.</b>
        <span>For “${esc(f?.name ?? flightId)}” · block ${r.height.toLocaleString()} · fee ${qor(r.feeUqor.toString())} QOR</span>
        <span class="mono block">${esc(r.txhash)}</span></div></div>
        <p class="muted tiny next">Next: the watchtower opens the sealed record and checks the six rules. Rule broken: 5 QOR plus your deposit go to your claim wallet. No rule broken: an insurer reviews your claim${evidence ? " (keep your photo to show them)" : ""}. Check back with your address below.</p>`;
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


/* ---------- insurer desk ---------- */

function insurerPage() {
  const review = data.claims.filter((c) => c.status === "review");
  const decided = data.claims.filter((c) => c.decision);
  const card = (c: Data["claims"][number], i: number) => {
    const f = flights.find((x) => x.id === c.flight);
    return `<div class="card review" data-i="${i}">
      <div class="review-head"><div class="grow"><b>“${esc(c.note)}”</b><span class="muted">by <span class="mono">${esc(c.victim)}</span></span></div>${badge("warn", "Waiting for you")}</div>
      <div class="kv">
        <div><span>Flight</span><b><a class="link" href="#/flights/${encodeURIComponent(c.flight)}">${esc(f?.name ?? c.flight)}</a></b></div>
        <div><span>Rules check</span><b>No rule broken in the signed record</b></div>
        <div><span>When / where (victim says)</span><b>${esc(c.when ?? "—")} · ${esc(c.where ?? "—")}</b></div>
        <div><span>Deposit</span><b>${qor(c.deposit ?? "0")} QOR (kept if you reject)</b></div>
      </div>
      <div class="tamper">
        <span class="grow tiny">${c.evidence ? `Photo fingerprint on chain: <span class="mono">${esc(c.evidence.slice(0, 24))}…</span>` : "No photo filed with this claim."}</span>
        ${c.evidence ? `<label class="btn sm">Check the victim's photo<input type="file" accept="image/*" hidden data-photo="${i}" /></label>` : ""}
        <button class="btn sm" data-open="${i}">Open the flight record</button>
      </div>
      <div class="msg-out" id="rv${i}"></div>
      <label class="claim-form"><span>Your reason (stored on chain)</span><input data-reason="${i}" maxlength="280" placeholder="e.g. Photo shows damage at the drop point, matches the flight path." /></label>
      <div class="file-actions"><button class="btn primary" data-decide="${i}" data-approve="1" disabled>Approve: pay 5 QOR + deposit</button><button class="btn" data-decide="${i}" data-approve="0" disabled>Reject: false claim, keep deposit</button></div>
    </div>`;
  };
  return `
  <section class="wrap page">
    <div class="head"><h1>Insurer desk</h1><p>Claims where the drone's signed record shows no broken rule come here. Check the victim's proof, open the sealed flight record, then approve or reject. Your decision is signed with your quantum-safe key and the watchtower pays (or keeps the deposit) on its next check.</p></div>
    <div class="card form">
      <label><span>Insurer key file</span><input type="file" id="insKey" accept=".json" /></label>
      <span class="muted tiny" id="insWho">Not signed in. Create the demo key with <code>npm run insurer-key</code> in <code>rollup/</code>.</span>
    </div>
    <h2 class="sub-h">Waiting for review (${review.length})</h2>
    <div class="list">${review.map((c) => card(c, data.claims.indexOf(c))).join("") || `<div class="card empty muted">Nothing to review. Claims appear here when the rules find no breach.</div>`}</div>
    <h2 class="sub-h">Decided</h2>
    <div class="card flush"><div class="scroll"><table class="table"><thead><tr><th>Claim</th><th>Decision</th><th>Reason</th></tr></thead>
      <tbody>${decided.map((c) => `<tr><td>“${esc(c.note)}”<span class="muted block">${esc(short(c.victim))}</span></td><td>${claimBadge(c)}</td><td>${esc(c.decision!.reason)}</td></tr>`).join("") || `<tr><td colspan="3" class="muted">No decisions yet</td></tr>`}</tbody></table></div></div>
  </section>`;
}

function insurerReady() {
  let keys: SigningKeys | undefined;
  let kem: { address: string; seed: string } | undefined;
  $<HTMLInputElement>("#insKey").addEventListener("change", async (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    try {
      const k = JSON.parse(await file.text());
      if (k.role !== "insurer" || !k.secp256k1PrivateKey || !k.mldsa87) throw new Error("not an insurer key");
      if (data.insurer && k.address !== data.insurer) throw new Error("this key is not the rollup's insurer");
      keys = keysFromFile(k);
      kem = { address: k.address, seed: k.mlkem1024Seed };
      $("#insWho").innerHTML = `Signed in as insurer <span class="mono">${esc(short(k.address))}</span>. The key stays in this page.`;
      $$<HTMLButtonElement>("[data-decide]").forEach((b) => (b.disabled = false));
    } catch (err) {
      $("#insWho").innerHTML = `<span class="alert inline">That isn't the insurer key file (${esc(err instanceof Error ? err.message : String(err))}).</span>`;
    }
  });
  $$<HTMLInputElement>("[data-photo]").forEach((inp) =>
    inp.addEventListener("change", async () => {
      const i = Number(inp.dataset.photo);
      const f = inp.files?.[0];
      if (!f) return;
      const same = (await fileFingerprint(f)) === data.claims[i].evidence;
      $(`#rv${i}`).innerHTML = `<p class="found ${same ? "ok" : ""}">${same ? "✓ Same photo the victim filed on chain." : "✕ This is NOT the photo the victim filed. Its fingerprint doesn't match."}</p>`;
    }),
  );
  $$<HTMLButtonElement>("[data-open]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const i = Number(btn.dataset.open);
      if (!kem) {
        $(`#rv${i}`).innerHTML = `<p class="alert">Load the insurer key file first: it opens the sealed record.</p>`;
        return;
      }
      try {
        const r = openFlight(data as unknown as InvestigatorData, data.claims[i].flight, kem);
        $(`#rv${i}`).innerHTML = `<div class="inv-mini"><div class="rules">${ruleList(brokenRules(r.verdict))}</div>
          <p class="tiny muted">${r.segments} sealed parts opened · ${r.recs.length} records${r.errors.length ? " · problems: " + esc(r.errors.join("; ")) : " · all match the drone's signatures"}</p>
          ${r.permit ? `<div class="mapbox">${drawFlight(r.recs, r.permit, r.verdict)}</div>` : ""}</div>`;
      } catch (err) {
        $(`#rv${i}`).innerHTML = `<p class="alert">Couldn't open: ${esc(err instanceof Error ? err.message : String(err))}</p>`;
      }
    }),
  );
  $$<HTMLButtonElement>("[data-decide]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const i = Number(btn.dataset.decide);
      const c = data.claims[i];
      const approve = btn.dataset.approve === "1";
      const reason = $<HTMLInputElement>(`[data-reason="${i}"]`).value.trim();
      const out = $(`#rv${i}`);
      if (!keys) return;
      if (!reason) {
        out.innerHTML = `<p class="alert">Write a reason first. It is stored on chain with your decision.</p>`;
        return;
      }
      $$<HTMLButtonElement>(`[data-decide="${i}"]`).forEach((b) => (b.disabled = true));
      try {
        const r = await postDecision(client, keys, data.rollup.rollupId, { flight: c.flight, victim: c.victim, approve, reason }, (step) => {
          out.innerHTML = `<p class="found"><i class="spin inline"></i>${esc(step)}</p>`;
        });
        out.innerHTML = `<div class="result ${approve ? "ok" : "bad"}"><span class="icon">${approve ? "✓" : "✕"}</span><div><b>${approve ? "Approved." : "Rejected."} Decision signed and posted.</b>
          <span>Block ${r.height.toLocaleString()} · the watchtower ${approve ? "pays the victim" : "keeps the deposit"} on its next check.</span><span class="mono block">${esc(r.txhash)}</span></div></div>`;
      } catch (err) {
        out.innerHTML = `<p class="alert">${esc(err instanceof Error ? err.message : String(err))}</p>`;
        $$<HTMLButtonElement>(`[data-decide="${i}"]`).forEach((b) => (b.disabled = false));
      }
    }),
  );
}



/* ---------- guided demo: one real flight, end to end, checked live ---------- */

const scenarioOf = (f: Flight): SimScenario => {
  const k = Object.keys(FLIGHT_NAME).find((x) => f.id.includes(`-${x}-`)) ?? "normal";
  return (SIM_SCENARIOS as readonly string[]).includes(k) ? (k as SimScenario) : "cheating";
};
const sha256Hex = async (h: string) => {
  const bytes = Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
};
/** The payout that paid a claim: the first withdrawal to the victim in a batch after the claim. */
function payoutFor(c: Data["claims"][number]) {
  if (c.status !== "paid") return undefined;
  const post = data.posts.find((p) => p.kind === "claim" && p.detail === c.flight && p.poster === c.victim);
  const used = new Set<string>();
  for (const x of data.claims.filter((y) => y.status === "paid" && y.victim === c.victim)) {
    const xp = data.posts.find((p) => p.kind === "claim" && p.detail === x.flight && p.poster === x.victim);
    for (const b of data.batches) {
      if (xp && b.index <= xp.batch) continue;
      const w = b.withdrawals.find((w) => w.recipient === x.victim && w.index !== undefined && !used.has(w.index));
      if (!w) continue;
      used.add(w.index!);
      if (x === c) return { batch: b.index, amount: w.amount, tx: data.withdrawalsExecuted?.[w.index!], claimHeight: post?.height };
      break;
    }
  }
  return undefined;
}

let tourFlight = "";
function tourPage() {
  const pick = flights.find((f) => f.id === tourFlight) ?? flights.find((f) => f.id.includes("-cheating-")) ?? flights[0];
  tourFlight = pick.id;
  const c = pick.claim;
  const sc = scenarioOf(pick);
  const pay = c ? payoutFor(c) : undefined;
  const claimPost = c ? data.posts.find((p) => p.kind === "claim" && p.detail === pick.id && p.poster === c.victim) : undefined;
  const broken = brokenRules(c?.verdict);
  const fraud = data.fraud?.[0];
  const step = (n: number, title: string, lead: string, body: string) =>
    `<li class="card tour-step"><div class="tour-n">${n}</div><div class="tour-body"><h3>${title}</h3><p class="muted">${lead}</p>${body}</div></li>`;
  return `
  <section class="wrap page">
    <div class="head"><h1>Guided demo</h1><p>One real drone flight on QoreChain testnet, from take-off to payout, in seven steps. Every “Check” button asks the chain live from your browser, so you don't have to trust this page.</p></div>
    <div class="card tour-pick">
      <span class="muted">Follow this flight:</span>
      <div class="seg">${flights.map((f) => `<button class="${f.id === pick.id ? "on" : ""}" data-tf="${esc(f.id)}">${esc(f.name)}</button>`).join("")}</div>
    </div>
    <ol class="tour">
      ${step(1, "The drone flies and asks permission", `Before every take-off, drop and landing the drone asks an AI safety check: “may I?”. Here's this flight's scenario played in 3D.`,
        `<div id="tourView" class="view tour-view"></div>
         <p class="tiny muted">Animation: the same scenario (“${esc(SCENARIO[sc].name)}”) run through the drone simulator. The real record is sealed: only the investigator and insurer can open it (step 5).</p>`)}
      ${step(2, "Every part is signed with a quantum-safe key and saved on QoreChain", `The drone signs each part of its log with ML-DSA-87 and posts it to the rollup's inbox. ${pick.segs.length} parts, ${pick.records} records.`,
        `<div class="tour-act"><button class="btn primary" id="tChain">Check on QoreChain</button><span class="tiny muted">Fetches each part's fingerprint from the chain and compares it to the signed part, then re-checks the drone's signature.</span></div>
         <div class="tour-out" id="tChainOut"></div>`)}
      ${step(3, "Nobody can edit it, not even the operator", "Change one number in the record and the drone's signature stops matching.",
        `<div class="tour-act"><button class="btn" id="tTamper">Try to edit the record</button><span class="tiny muted">Removes one moment from part 1 in your browser.</span></div><div class="tour-out" id="tTamperOut"></div>`)}
      ${step(4, "Someone on the ground files a claim", c ? "A claim is a signed post on the same rollup, so it is on the record too." : "Nobody filed a claim on this flight. Pick another flight above to see one.",
        c ? `<div class="kv"><div><span>Claim</span><b>“${esc(c.note)}”</b></div><div><span>Filed by</span><b class="mono">${esc(short(c.victim))}</b></div>
            <div><span>On chain</span><b>${claimPost ? `Block ${claimPost.height.toLocaleString()}` : "—"}</b></div><div><span>Deposit</span><b>${BigInt(c.deposit ?? "0") > 0n ? `${qor(c.deposit!)} QOR (refundable)` : "None (filed before deposits)"}</b></div></div>
            <p class="tiny"><a class="link" href="#/claims/${encodeURIComponent(pick.id)}">File your own claim on this flight →</a></p>` : "")}
      ${step(5, "The watchtower opens the sealed record and checks six rules", "The judge decrypts the record with its ML-KEM-1024 key and runs the six safety rules. No person decides this part.",
        `<div class="result ${c ? (c.verdict?.breach ? "bad" : "ok") : "wait"}"><span class="icon">${c ? (c.verdict?.breach ? "✕" : "✓") : "·"}</span><div><b>${c ? (c.verdict?.breach ? `Rule broken: ${broken.map((r) => esc(RULE[r] ?? r)).join(", ")}` : "No rule broken") : "Not judged: no claim"}</b>
          <span>${c?.verdict?.breach ? esc(c.verdict.findings[0]?.detail ?? "") : c?.decision ? "The drone followed every rule, so the claim went to the insurer for a human review." : c ? "The claim was rejected: the signed record shows the drone followed every rule." : "Rules are checked when someone claims."}</span></div></div>
         ${c?.decision ? `<div class="result ${c.decision.approve ? "ok" : "bad"}"><span class="icon">${c.decision.approve ? "✓" : "✕"}</span><div><b>Insurer ${c.decision.approve ? "approved" : "rejected"} the claim</b><span>“${esc(c.decision.reason)}” · signed with the insurer's quantum-safe key, on chain</span></div></div>` : ""}
         <div class="rules">${ruleList(broken)}</div>`)}
      ${step(6, "The victim is paid automatically", pay ? `The judge signs a payout from the claims pool${BigInt(c?.deposit ?? "0") > 0n ? ", with the claimant's 1 QOR deposit back" : ""}. QoreChain settles it after the challenge window.` : c ? "No rule was broken, so nothing was paid. A claim filed today would go to the insurer for a human review." : "No claim, no payout.",
        pay ? `<div class="kv"><div><span>Paid</span><b>${qor(pay.amount)} QOR to ${esc(short(c!.victim))}</b></div><div><span>In batch</span><b>${pay.batch}</b></div></div>
              ${pay.tx ? `<div class="tour-act"><button class="btn primary" id="tPay" data-tx="${esc(pay.tx)}">Check the payment on QoreChain</button><span class="tiny mono muted">${esc(short(pay.tx, 10))}</span></div><div class="tour-out" id="tPayOut"></div>` : ""}` : "")}
      ${step(7, "A cheating operator loses their bond", "The operator once posted a batch with a fake payout list. The watchtower re-ran it, proved the fraud on chain, and QoreChain slashed the operator.",
        fraud ? `<div class="kv"><div><span>Fake batch</span><b>#${esc(fraud.batch)}</b></div><div><span>Operator lost</span><b>${qor(fraud.slashed)} QOR (half burned)</b></div></div>
          <div class="tour-act"><button class="btn primary" id="tFraud" data-tx="${esc(fraud.tx)}">Check the fraud proof on QoreChain</button><span class="tiny mono muted">${esc(short(fraud.tx, 10))}</span></div><div class="tour-out" id="tFraudOut"></div>` : "")}
    </ol>
    <div class="card tour-next">
      <b>Try each role yourself</b>
      <div class="who-mini">
        <a class="btn" href="#/claims">I was hurt: file a claim</a>
        <a class="btn" href="#/operator">I run drones: operator console</a>
        <a class="btn" href="#/insurer">I'm the insurer: review claims</a>
        <a class="btn" href="#/proof">Verify every batch</a>
      </div>
    </div>
  </section>`;
}

function tourReady() {
  const f = flights.find((x) => x.id === tourFlight)!;
  $$<HTMLButtonElement>("[data-tf]").forEach((b) =>
    b.addEventListener("click", () => {
      tourFlight = b.dataset.tf!;
      const y = window.scrollY;
      route();
      window.scrollTo(0, y);
    }),
  );
  const sc = scenarioOf(f);
  const recs = simulate({ scenario: sc, flight: `tour-${sc}`, drone: "SKY-001", permit: DEMO_PERMIT, permitHash: "demo", seed: 7 + SIM_SCENARIOS.indexOf(sc) });
  disposeArenas();
  arenas.push(mountArena($("#tourView"), recs as Rec[], DEMO_PERMIT, judge(recs, DEMO_PERMIT), { autoplay: true, compact: true }));

  const busy = (el: HTMLElement, t: string) => (el.innerHTML = `<p class="found"><i class="spin inline"></i>${esc(t)}</p>`);
  $<HTMLButtonElement>("#tChain").addEventListener("click", async () => {
    const out = $("#tChainOut");
    busy(out, "Asking QoreChain…");
    const posts = data.headers.filter((h) => parseHeaderPost(h.post).header.flight === f.id);
    const rows = await Promise.all(
      posts.map(async (h) => {
        const p = parseHeaderPost(h.post);
        const onChain = await client.rest.getPostedData(data.rollup.rollupId, h.seq).catch(() => undefined);
        const match = !!onChain && onChain.dataHash.toLowerCase() === (await sha256Hex(h.post));
        const sig = verifyHeader(p.header, p.signature, data.drones[p.header.drone].publicKey);
        return { idx: p.header.idx, seq: h.seq, height: onChain?.height ?? h.height, kept: !!onChain, match, sig };
      }),
    );
    rows.sort((a, b) => a.idx - b.idx);
    const good = rows.filter((r) => (r.match || !r.kept) && r.sig).length;
    const kept = rows.filter((r) => r.kept).length;
    out.innerHTML = `<div class="result ${good === rows.length ? "ok" : "bad"}"><span class="icon">${good === rows.length ? "✓" : "✕"}</span><div>
      <b>${good === rows.length ? `All ${rows.length} parts check out` : `${rows.length - good} part(s) don't match`}</b>
      <span>${kept} of ${rows.length} matched byte for byte with QoreChain's copy${kept < rows.length ? " (older posts the chain no longer keeps were checked by signature only)" : ""} · drone signatures valid.</span></div></div>
      <div class="scroll"><table class="table"><thead><tr><th>Part</th><th>Inbox #</th><th>Block</th><th>Same as on chain</th><th>Drone signature</th></tr></thead><tbody>
      ${rows.map((r) => `<tr><td>${r.idx + 1}</td><td>${r.seq}</td><td>${r.height.toLocaleString()}</td><td>${r.kept ? badge(r.match ? "ok" : "bad", r.match ? "Yes" : "No") : badge("plain", "Not kept")}</td><td>${badge(r.sig ? "ok" : "bad", r.sig ? "Valid" : "Invalid")}</td></tr>`).join("")}
      </tbody></table></div>`;
  });
  $<HTMLButtonElement>("#tTamper").addEventListener("click", () => {
    const s0 = f.segs[0];
    const ok = verifyHeader({ ...s0.header, n: s0.header.n - 1 }, s0.signature, data.drones[s0.header.drone].publicKey);
    $("#tTamperOut").innerHTML = `<div class="result ${ok ? "bad" : "ok"}"><span class="icon">${ok ? "✕" : "✓"}</span><div><b>${ok ? "Edit not detected" : "Edit caught"}</b>
      <span>Part 1 claimed ${s0.header.n} records; we changed it to ${s0.header.n - 1}. ${ok ? "" : "The drone's quantum-safe signature no longer matches, so the edited record is rejected."}</span></div></div>`;
  });
  const txCheck = (btnId: string, outId: string, what: string) => {
    const btn = document.getElementById(btnId) as HTMLButtonElement | null;
    btn?.addEventListener("click", async () => {
      const out = $(outId);
      busy(out, "Asking QoreChain…");
      try {
        const t = (await client.rest.getTx(btn.dataset.tx!)) as { tx_response?: { code: number; height: string; timestamp?: string; gas_used?: string } };
        const r = t.tx_response;
        if (!r) throw new Error("not found");
        out.innerHTML = `<div class="result ${r.code === 0 ? "ok" : "bad"}"><span class="icon">${r.code === 0 ? "✓" : "✕"}</span><div><b>${r.code === 0 ? `${what}: confirmed on QoreChain` : `Transaction failed (code ${r.code})`}</b>
          <span>Block ${Number(r.height).toLocaleString()}${r.timestamp ? ` · ${esc(new Date(r.timestamp).toLocaleString())}` : ""} · signed with a hybrid quantum-safe signature</span></div></div>`;
      } catch (e) {
        out.innerHTML = `<p class="alert">Couldn't read it from QoreChain right now (${esc(e instanceof Error ? e.message : String(e))}).</p>`;
      }
    });
  };
  txCheck("tPay", "#tPayOut", "Payment");
  txCheck("tFraud", "#tFraudOut", "Fraud proof");
}

/* ---------- operator console ---------- */

/** When a flight started: the drone's flight id ends in its take-off time (ms). */
const flightTime = (id: string) => {
  const ms = Number(id.split("-").pop());
  return Number.isFinite(ms) && ms > 1e12 ? new Date(ms) : undefined;
};
const claimCost = (c: Data["claims"][number]) => BigInt(data.claimsPool?.payoutUqor ?? "5000000") + BigInt(c.deposit ?? "0");

function operatorPage() {
  const op = data.rollup.creator;
  const against = data.claims;
  const pending = against.filter((c) => c.status === "open" || c.status === "review");
  const exposure = pending.reduce((s, c) => s + claimCost(c), 0n);
  const paid = against.filter((c) => c.status === "paid");
  const slashed = (data.fraud ?? []).reduce((s, f) => s + Number(f.slashed.replace("uqor", "")), 0);
  const droneRows = Object.entries(data.drones).map(([id, d]) => {
    const fl = flights.filter((f) => f.segs[0]?.header.drone === id);
    const breaches = fl.filter((f) => f.claim?.verdict?.breach).length;
    return `<tr><td><b>${esc(id)}</b><span class="muted block mono">ML-DSA-87 key ${esc(d.publicKey.slice(0, 16))}…</span></td>
      <td>${fl.length}</td><td>${fl.reduce((n, f) => n + f.records, 0)}</td>
      <td>${badge(fl.every((f) => f.intact) ? "ok" : "bad", fl.every((f) => f.intact) ? "All intact" : "Broken record")}</td>
      <td>${breaches ? badge("bad", `${breaches} rule break${breaches > 1 ? "s" : ""}`) : badge("ok", "None found")}</td></tr>`;
  });
  const flightRows = [...flights]
    .sort((a, b) => (flightTime(b.id)?.getTime() ?? 0) - (flightTime(a.id)?.getTime() ?? 0))
    .map((f) => {
      const t = flightTime(f.id);
      const o = outcome(f.claim);
      const batches = [...new Set(f.segs.map((s) => s.batch))];
      return `<tr><td><a class="link" href="#/flights/${encodeURIComponent(f.id)}"><b>${esc(f.name)}</b></a><span class="muted block">${t ? esc(t.toLocaleString()) : "—"} · drone ${esc(f.segs[0]?.header.drone ?? "?")}</span></td>
        <td>${f.records}<span class="muted block">${f.segs.length} sealed parts</span></td>
        <td>${badge(f.intact ? "ok" : "bad", f.intact ? "Intact" : "Broken")}</td>
        <td>${batches.map((b) => `<span class="bstatus" data-b="${b}">${badge("plain", `batch ${b}`)}</span>`).join(" ")}</td>
        <td>${badge(o.tone, o.label)}</td></tr>`;
    });
  const claimRows = against.map((c) => {
    const f = flights.find((x) => x.id === c.flight);
    const cost = c.status === "paid" ? `${qor(claimCost(c).toString())} QOR paid` : c.status === "rejected" ? "Nothing paid" : `Up to ${qor(claimCost(c).toString())} QOR`;
    return `<tr><td>“${esc(c.note)}”<span class="muted block">${esc(short(c.victim))}${c.height ? ` · block ${c.height.toLocaleString()}` : ""}</span></td>
      <td><a class="link" href="#/flights/${encodeURIComponent(c.flight)}">${esc(f?.name ?? c.flight)}</a></td><td>${claimBadge(c)}</td><td>${cost}</td></tr>`;
  });
  const stats: [string, string, string][] = [
    ["opBond", `${qor(data.rollup.stakeAmount)} QOR`, "bond locked in the rollup"],
    ["", `${Object.keys(data.drones).length} · ${flights.length}`, "drones · flights on record"],
    ["", `${pending.length}`, `claims pending (up to ${qor(exposure.toString())} QOR)`],
    ["", `${paid.length} · ${qor(paid.reduce((s, c) => s + claimCost(c), 0n).toString())} QOR`, "claims paid · total"],
  ];
  return `
  <section class="wrap page">
    <div class="head"><h1>Operator console</h1><p>Everything QoreChain holds about your drones: every flight they signed, its batch, the claims made against you and what they cost. You can't edit any of it, and neither can anyone else.</p></div>
    <div class="card op-id">
      <div class="grow"><span class="muted tiny">Operator (rollup creator)</span><b class="mono">${esc(op)}</b></div>
      ${badge(data.rollup.status === "active" ? "ok" : "warn", `Rollup ${data.rollup.rollupId} · ${data.rollup.status}`)}
      ${slashed ? badge("bad", `Slashed ${qor(slashed)} QOR for a fake batch`) : ""}
    </div>
    <div class="stats op-stats">${stats.map(([id, v, k]) => `<div><b${id ? ` id="${id}"` : ""}>${esc(v)}</b><span>${esc(k)}</span></div>`).join("")}</div>

    <h2 class="sub-h">Live chain activity <span class="live-dot" id="opLiveDot"></span></h2>
    <div class="card op-live">
      <p class="muted tiny" id="opLiveNote">Reading the rollup's inbox on QoreChain…</p>
      <div class="scroll"><table class="table"><thead><tr><th>Post</th><th>From</th><th>Size</th><th>Block</th></tr></thead><tbody id="opLive"></tbody></table></div>
      <p class="muted tiny">Every message to the rollup in order, read live from the chain every 10 seconds. A drone in the air posts a signed, sealed part of its flight every few seconds (run <code>npm run fly</code> in <code>rollup/</code> to see one arrive).</p>
    </div>

    <h2 class="sub-h">Your drones</h2>
    <div class="card flush"><div class="scroll"><table class="table"><thead><tr><th>Drone</th><th>Flights</th><th>Records</th><th>Signed records</th><th>Rules</th></tr></thead><tbody>${droneRows.join("")}</tbody></table></div></div>

    <h2 class="sub-h">Flight log</h2>
    <div class="card flush"><div class="scroll"><table class="table"><thead><tr><th>Flight</th><th>Records</th><th>Signed record</th><th>Saved in</th><th>Claim</th></tr></thead><tbody>${flightRows.join("")}</tbody></table></div></div>

    <h2 class="sub-h">Claims against you</h2>
    <div class="card flush"><div class="scroll"><table class="table"><thead><tr><th>Claim</th><th>Flight</th><th>Status</th><th>Cost to you</th></tr></thead><tbody>${claimRows.join("") || `<tr><td colspan="4" class="muted">No claims</td></tr>`}</tbody></table></div></div>
    <p class="muted tiny">A bond exit (taking your QOR back out) waits while any claim is open or with the insurer, so a victim can always be paid.</p>
  </section>`;
}

let opPoll: ReturnType<typeof setInterval> | undefined;
function operatorReady() {
  const op = data.rollup.creator;
  const known = new Map(data.posts.map((p) => [`${p.height}|${p.poster}`, p]));
  const label = (poster: string, height: number) => {
    const k = known.get(`${height}|${poster}`);
    if (k) return k.kind === "header" ? "Flight part (signed header)" : k.kind === "sealed body" ? "Flight part (sealed record)" : k.kind[0].toUpperCase() + k.kind.slice(1);
    if (poster.startsWith("deposit:")) return "Deposit";
    if (poster === op) return "Operator post (drone data)";
    if (poster === data.insurer) return "Insurer decision";
    return "Claim or other post";
  };
  const tick = async () => {
    if (!document.getElementById("opLive")) return clearInterval(opPoll);
    const [inbox, roll] = await Promise.all([client.rest.getInbox(data.rollup.rollupId), client.rest.getRollup(data.rollup.rollupId)]);
    const head = inbox.headSequence;
    const seqs = Array.from({ length: Math.min(10, head) }, (_, i) => head - i);
    const rows = await Promise.all(seqs.map((q) => client.rest.getPostedData(data.rollup.rollupId, q).catch(() => undefined)));
    const fresh = head - data.posts.length;
    $("#opLive").innerHTML = rows
      .map((r, i) => {
        if (!r) return `<tr><td colspan="4" class="muted">#${seqs[i]} no longer kept by the chain</td></tr>`;
        const who = r.poster.startsWith("deposit:") ? r.poster.slice(8) : r.poster;
        return `<tr><td><b>#${r.sequence}</b> ${esc(label(r.poster, r.height))}</td><td class="mono">${who === op ? "you" : esc(short(who))}</td><td>${r.size.toLocaleString()} B</td><td>${r.height.toLocaleString()}</td></tr>`;
      })
      .join("");
    $("#opLiveNote").textContent = `${head.toLocaleString()} messages in the inbox · ${inbox.consumedSequence.toLocaleString()} already settled in a batch${head > inbox.consumedSequence ? ` · ${head - inbox.consumedSequence} waiting for the next batch` : ""}${fresh > 0 ? ` · ${fresh} newer than this page's saved data` : ""}.`;
    $("#opLiveDot").className = "live-dot on";
    const bond = document.getElementById("opBond");
    if (bond && roll.escrowBalance) bond.textContent = `${qor(roll.escrowBalance)} QOR`;
  };
  clearInterval(opPoll);
  tick().catch((e) => {
    console.error("operator live:", e);
    $("#opLiveNote").textContent = "Couldn't reach QoreChain right now. Showing saved data only.";
  });
  opPoll = setInterval(() => tick().catch(() => undefined), 10_000);
}

/* ================= router + live status ================= */

const pages: Record<string, [() => string, (() => void)?]> = {
  "": [home, homeReady],
  flights: [flightsPage, flightsReady],
  claims: [claimsPage, claimsReady],
  proof: [proofPage, proofReady],
  investigate: [investigatePage, investigateReady],
  insurer: [insurerPage, insurerReady],
  operator: [operatorPage, operatorReady],
  tour: [tourPage, tourReady],
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
