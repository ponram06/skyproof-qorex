import "./polyfill";
import { buildSettlementReceipt, createRdkClient, verifySettlementReceipt } from "@qorechain/rdk";
import { parseHeaderPost, verifyHeader, type SegmentHeader } from "./verify";
import { drawFlight, openFlight, type InvestigatorData } from "./investigator";
import { mountArena, plain, type ArenaHandle, type Rec } from "./arena";
import { DEMO_WORLD, simulate, SIM_SCENARIOS, type SimScenario, type World } from "../../rollup/src/sim/sim";
import { DEMO_PERMIT } from "../../rollup/src/flight/scenarios";
import { judge, type Verdict } from "../../rollup/src/rules";
import { parseClaim, type Claim } from "../../rollup/src/flight/posts";
import { FLEET } from "../../rollup/src/flight/fleet";
import type { Permit } from "../../rollup/src/rules";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { balanceUqor, CLAIM_FUNDS_QOR, createWallet, fileClaim, fileFingerprint, forgetWallet, keysFromFile, loadWallet, newWallet, postDecision, restoreWallet, type ClaimWallet, type SigningKeys } from "./wallet";

/* ================= data ================= */

interface Data {
  generatedAt: string;
  chainId: string;
  rollup: { rollupId: string; creator: string; status: string; settlementMode: string; executionVm: string; sequencing: string; layerId: string; challengeWindowSec?: number; stakeAmount: string };
  drones: Record<string, { publicKey: string; permit?: Permit }>;
  batches: { index: number; status: string; inboxStart: number; inboxEnd: number; submittedTime: number; tx?: string; withdrawals: { index?: string; recipient: string; amount: string }[] }[];
  headers: { batch: number; seq: number; height: number; post: string }[];
  bodies?: Record<string, string>;
  /** Hashes of the sealed bodies; the bodies themselves are in skyproof-bodies.json. */
  bodyHashes?: string[];
  posts: { batch: number; seq: number; height: number; poster: string; kind: string; detail: string }[];
  fraud?: { tx: string; height: number; batch: string; challenger: string; slashed: string; burned: string }[];
  withdrawalsExecuted?: Record<string, string>;
  claims: { flight: string; victim: string; note: string; status: string; verdict?: Verdict; deposit?: string; height?: number; when?: string; where?: string; evidence?: string; decision?: { approve: boolean; reason: string }; drone?: string; missing?: boolean; payTo?: string }[];
  claimsPool?: { account: string; depositUqor: string; payoutUqor: string };
  insurer?: string;
  watchtower?: { batch: number; valid: boolean; note: string }[];
  pendingPayouts?: { nonce: string; amount: string; recipient: string; reason: string; tx: string }[];
  demoWallets?: string[];
  demoFlights?: string[];
  audit?: { checkedAt: string; batches: number; rows: { batch: number; recipient: string; amount: string; justified: boolean; reason: string }[]; owed: { recipient: string; amount: string; reason: string }[] };
}

interface Segment { header: SegmentHeader; signature: Uint8Array; batch: number; seq: number; sigOk: boolean; chainOk: boolean; sealed: boolean }
interface Flight { id: string; name: string; segs: Segment[]; intact: boolean; records: number; claim?: Data["claims"][number]; claims: Data["claims"] }

/* ================= words ================= */

const SCENARIO: Record<SimScenario, { name: string; hint: string; about: string }> = {
  normal: { name: "Normal delivery", hint: "By the book", about: "The drone asks before every move and gets a “Yes” each time." },
  people_below: { name: "Someone below", hint: "Drone waits", about: "A person is under the drop point. The drone hears “No”, waits, and drops once they leave." },
  link_lost: { name: "Signal lost", hint: "Lands safely", about: "The drone loses its safety check. It doesn't guess; it lands where it is." },
  cheating: { name: "Operator ignores “No”", hint: "Person hit", about: "A person is under the drop point. The safety check says “No”. The operator drops anyway." },
  unapproved: { name: "Never asked", hint: "Breaks a rule", about: "The operator drops the parcel without asking first." },
  shortcut: { name: "No-fly shortcut", hint: "Breaks a rule", about: "The operator cuts straight through a no-fly zone." },
  altitude: { name: "Too high", hint: "Breaks a rule", about: "The operator cruises above the 120 m limit." },
  wind: { name: "Too windy", hint: "Car hit", about: "The safety check says it's too windy. The operator takes off anyway." },
};
const SAFE: SimScenario[] = ["normal", "people_below", "link_lost"];
/** The try-it shows only these four: each one looks different in 3D. */
const SHOWN: SimScenario[] = ["normal", "people_below", "cheating", "wind"];
/** Try-it: each scenario delivers to its own address (metres east, north of home base; the no-fly zone is 1.55 km north). */
const lRoute = (x: number, y: number): World => ({ home: [0, 0], drop: [x, y], route: [[x, 0], [x, y]], shortcut: [[x, y]] });
const TRY_WORLDS: Record<SimScenario, World> = {
  normal: lRoute(1300, 700),
  people_below: lRoute(-1200, 800),
  link_lost: { home: [0, 0], drop: [1200, -1300], route: [[600, -400], [1200, -900], [1200, -1300]], shortcut: [[1200, -1300]] },
  cheating: lRoute(-700, 1300),
  unapproved: lRoute(300, -1400),
  shortcut: DEMO_WORLD,
  altitude: lRoute(1000, 1200),
  wind: lRoute(-1300, -900),
};
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
  wind: "Too windy, operator flew anyway",
};

/* ================= helpers ================= */

/** The sealed bodies (ciphertext), fetched only when someone opens a record. */
let bodiesOf = "";
async function withBodies() {
  if (data.bodies && bodiesOf === data.generatedAt) return;
  if (!data.bodyHashes) return; // an older data file that still carries the bodies inline
  const res = await fetch("/skyproof-bodies.json", { cache: "no-store" });
  if (!res.ok) throw new Error(`couldn't load the sealed records (HTTP ${res.status})`);
  data.bodies = await res.json();
  bodiesOf = data.generatedAt;
}

const client = createRdkClient({ network: "testnet", endpoints: { rest: `${location.origin}/api/rest`, rpc: `${location.origin}/api/rpc` } });
const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector<T>(sel)!;
const $$ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => [...root.querySelectorAll<T>(sel)];
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const qor = (uqor: string | number) => (Number(String(uqor).replace("uqor", "")) / 1e6).toLocaleString(undefined, { maximumFractionDigits: 2 });
const short = (s: string, n = 8) => (s.length > 2 * n + 1 ? `${s.slice(0, n)}…${s.slice(-6)}` : s);
const badge = (tone: "ok" | "bad" | "warn" | "plain", text: string) => `<span class="badge ${tone}">${esc(text)}</span>`;
const brokenRules = (v?: Verdict) => [...new Set(v?.findings.map((f) => f.rule) ?? [])];
const ruleList = (broken: string[]) => RULES.map(([k, t]) => `<span class="${broken.includes(k) ? "x" : ""}">${broken.includes(k) ? "✕" : "✓"} ${esc(t)}</span>`).join("");

/** When a flight started: the drone's flight id ends in its take-off time (ms). */
const flightTime = (id: string) => {
  const ms = Number(id.split("-").pop());
  return Number.isFinite(ms) && ms > 1e12 ? new Date(ms) : undefined;
};

/** Ground distance in metres (equirectangular; fine at city scale). */
/** When the drones flew, read from the flights on chain (per area, newest days first). */
function flightDays() {
  const by = new Map<string, Set<string>>();
  for (const f of flights) {
    const t = flightTime(f.id);
    const area = FLEET[f.segs[0]?.header.drone]?.area.split(",")[0];
    if (!t || !area) continue;
    const day = t.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
    (by.get(day) ?? by.set(day, new Set()).get(day)!).add(area);
  }
  const days = [...by.entries()].sort((a, b) => new Date(b[0]).getTime() - new Date(a[0]).getTime()).slice(0, 3);
  return days.length ? `drones flew on ${days.map(([d, a]) => `<b>${esc(d)}</b> (${[...a].map(esc).join(", ")})`).join(", ")}` : "no flights on record yet";
}
const distM = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) =>
  Math.hypot((a.lat - b.lat) * 111_320, (a.lon - b.lon) * 111_320 * Math.cos((a.lat * Math.PI) / 180));

/** When a flight was in the air: take-off from its id, end from its last signed part's block (2 s blocks). */
function flightWindow(f: Flight): { start?: number; end?: number } {
  const start = flightTime(f.id)?.getTime();
  if (start === undefined) return {};
  const hs = data.headers.filter((h) => parseHeaderPost(h.post).header.flight === f.id).map((h) => h.height);
  const span = hs.length ? (Math.max(...hs) - Math.min(...hs)) * 2000 : 0;
  return { start, end: start + Math.max(60_000, span + 30_000) };
}

let data: Data;
let flights: Flight[] = [];
let arenas: ArenaHandle[] = [];
const disposeArenas = () => {
  arenas.forEach((a) => a.dispose());
  arenas = [];
};

function buildFlights(d: Data): Flight[] {
  const by = new Map<string, Segment[]>();
  const bodies = new Set(d.bodyHashes ?? Object.keys(d.bodies ?? {}));
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
    const all = d.claims.filter((c) => c.flight === id);
    const demoAt = d.demoFlights?.includes(id) ? flightTime(id) : undefined;
    return {
      id,
      name: `${key ? FLIGHT_NAME[key] : id}${FLEET[segs[0].header.drone] ? ` · ${FLEET[segs[0].header.drone].area.split(",")[0]}` : ""}${demoAt ? ` · judge demo ${demoAt.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}` : ""}`,
      segs,
      intact: segs.every((s) => s.sigOk && s.chainOk && s.sealed),
      records: segs.reduce((n, s) => n + s.header.n, 0),
      // the newest claim on this flight (a flight can be claimed by several people)
      claim: all[all.length - 1],
      claims: all,
    };
  });
}

const paidTotal = (d: Data) =>
  d.batches.flatMap((b) => b.withdrawals).filter((w) => w.index !== undefined && d.withdrawalsExecuted?.[w.index]).reduce((s, w) => s + Number(w.amount), 0);

const payoutUqor = () => BigInt(data.claimsPool?.payoutUqor ?? "5000000");
/** What a paid claim received: the payout plus its deposit back. */
const claimPaid = (c: Data["claims"][number]) => payoutUqor() + BigInt(c.deposit ?? "0");

function outcome(c?: Flight["claim"]) {
  if (!c) return { tone: "plain" as const, label: "No claim" };
  if (c.status === "paid") return c.decision ? { tone: "bad" as const, label: `Insurer approved · ${qor(claimPaid(c).toString())} QOR paid` } : { tone: "bad" as const, label: `Rule broken · ${qor(claimPaid(c).toString())} QOR paid` };
  if (c.status === "rejected") return { tone: "ok" as const, label: c.decision ? "Insurer rejected the claim" : "Safe · claim rejected" };
  if (c.status === "review") return { tone: "warn" as const, label: "With the insurer" };
  return { tone: "warn" as const, label: "Claim open" };
}

/** A claim's flight as a link, or the drone and time it names when no flight was published. */
function claimFlight(c: Data["claims"][number]) {
  const f = flights.find((x) => x.id === c.flight);
  if (f) return `<a class="link" href="#/flights/${encodeURIComponent(c.flight)}">${esc(f.name)}</a>`;
  const [drone, when] = c.flight.split("@");
  return `<b>${esc(c.drone ?? drone)}</b> at ${esc((c.when ?? when ?? "").replace("T", " "))}<span class="muted block">${c.missing ? "No flight published by the operator" : "Waiting for the operator's record"}</span>`;
}

/** How a claim's status reads in the claims table. */
function claimBadge(c: Data["claims"][number]) {
  const back = BigInt(c.deposit ?? "0") > 0n ? " + deposit back" : "";
  if (c.status === "paid") return badge("bad", c.decision ? `Insurer approved · paid ${qor(payoutUqor().toString())} QOR${back}` : `Paid ${qor(payoutUqor().toString())} QOR${back}`);
  if (c.status === "rejected") return badge("ok", c.decision ? "Rejected by insurer · deposit kept" : "Rejected");
  if (c.status === "review") return badge("warn", c.missing ? "No record · with the insurer" : "With the insurer");
  return badge("warn", "Open");
}

/** "What is this page" box: who it is for, and what to do, in three steps. */
function guide(who: string, steps: string[]) {
  return `<div class="guide card"><div class="guide-who"><span class="muted tiny">This page is for</span><b>${who}</b></div>
    <ol class="guide-steps">${steps.map((s, i) => `<li><span class="n">${i + 1}</span><span>${s}</span></li>`).join("")}</ol></div>`;
}

/* ================= pages ================= */

function home() {
  const stats: [string, string][] = [
    [String(flights.length), "real flights on chain"],
    [`${qor(paidTotal(data))} QOR`, "paid to victims"],
    [String(data.fraud?.length ?? 0), "cheater caught"],
    ...(data.audit ? [[`${data.audit.rows.filter((r) => r.justified).length}/${data.audit.rows.length}`, "payouts passed the independent audit"] as [string, string]] : []),
    [String(data.batches.length), "batches settled"],
  ];
  return `
  <section class="hero wrap">
    <div class="eyebrow"><span class="pulse"></span>Live on QoreChain testnet</div>
    <h1>Every drone flight,<br /><span>on the record.</span></h1>
    <p class="sub">Drones log every move to a record nobody can edit. Break a safety rule, and the victim is paid automatically.</p>
    <div class="strip">
      ${[
        ["🛸", "A delivery drone flies", "It asks a safety check before every take-off, drop and landing."],
        ["🔒", "Every moment is locked", "Signed with a quantum-safe key and saved on QoreChain. Nobody can edit it."],
        ["✋", "Someone gets hurt", "They file a claim: where, when, what happened."],
        ["💸", "Rule broken? Paid", "The record is checked automatically and the victim is paid from the operator's bond."],
      ]
        .map(([i, t, p], k) => `<div class="strip-step"><span class="strip-i">${i}</span><b>${k + 1}. ${t}</b><span>${p}</span></div>`)
        .join("")}
    </div>
    <div class="start">
      <span class="muted">Start here:</span>
      <a class="btn primary" href="#/demo">I'm a judge: play every role live</a>
      <a class="btn" href="#/tour">3-minute guided tour</a>
      <a class="btn" href="#/claims">A drone hurt me: file a claim</a>
      <button class="btn" data-scroll="demo">Just show me a flight</button>
    </div>
    <div class="stats">${stats.map(([v, k]) => `<div><b>${esc(v)}</b><span>${esc(k)}</span></div>`).join("")}</div>
  </section>

  <section class="wrap section" id="demo">
    <div class="head"><h2>Try it</h2><p>Pick a situation. Green ones are safe flights; red ones break a rule. Watch the drone, and read each step under the view as it happens. This animation is a simulation in your browser; the real flights on QoreChain are on the <a class="link" href="#/flights">Flights</a> page, and you can fly one yourself in the <a class="link" href="#/demo">live demo</a>.</p></div>
    <div class="demo">
      <div class="picker" role="tablist" aria-label="Flight">
        ${SHOWN.map((s) => `<button role="tab" data-s="${s}" class="${SAFE.includes(s) ? "safe" : "risky"}"><b>${esc(SCENARIO[s].name)}</b><span>${esc(SCENARIO[s].hint)}</span></button>`).join("")}
      </div>
      <div class="stage">
        <div id="result" class="result" aria-live="polite"></div>
        <div id="simView" class="view"></div>
        <div id="ruleList" class="rules"></div>
      </div>
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
    const recs = simulate({ scenario: s, flight: `demo-${s}`, drone: "SKY-001", permit: DEMO_PERMIT, permitHash: "demo", seed: 7 + SIM_SCENARIOS.indexOf(s), world: TRY_WORLDS[s] });
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
    arenas.push(mountArena($("#simView"), recs as Rec[], DEMO_PERMIT, verdict, { autoplay: true, seed: SIM_SCENARIOS.indexOf(s) + 1, onBreach: reveal, onEnd: reveal }));
  };
  $$<HTMLButtonElement>(".picker button").forEach((b) => (b.onclick = () => fly(b.dataset.s as SimScenario)));
  fly("people_below");
}

function flightsPage() {
  return `
  <section class="wrap page">
    <div class="head"><h1>Flights</h1><p>Every real flight saved on QoreChain.</p></div>
    ${guide("Anyone who wants to check a record", ["Open a flight to see its drone, take-off time and claims.", "Press <b>Try to edit this record</b>: the drone's signature catches the change.", "Hurt by one? Press <b>File a claim</b> on it."])}
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
              <div><span>Drone</span><b>${esc(f.segs[0]?.header.drone ?? "?")}</b></div>
              <div><span>Took off</span><b>${flightTime(f.id) ? esc(flightTime(f.id)!.toLocaleString()) : "—"}</b></div>
              <div><span>Rules check</span><b>${broken.length ? `Broke: ${broken.map((r) => esc(RULE[r] ?? r)).join(", ")}` : f.claim ? "No rule broken" : "Checked when someone claims"}</b></div>
            </div>
            ${f.claims.length ? `<div class="scroll"><table class="table"><thead><tr><th>Claims on this flight (${f.claims.length})</th><th>Decision</th></tr></thead><tbody>${f.claims.map((c) => `<tr><td>“${esc(c.note)}”<span class="muted block mono">${esc(short(c.victim))}</span></td><td>${claimBadge(c)}</td></tr>`).join("")}</tbody></table></div>` : ""}
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
    const broken = brokenRules(c.verdict);
    return `<tr data-victim="${esc(c.victim)}">
      <td><b>“${esc(c.note)}”</b><span class="muted block">by ${esc(short(c.victim))}</span></td>
      <td>${claimFlight(c)}</td>
      <td>${claimBadge(c)}${broken.length ? `<span class="muted block">${broken.map((r) => esc(RULE[r] ?? r)).join(", ")}</span>` : ""}${c.decision ? `<span class="muted block">Insurer: “${esc(c.decision.reason)}”</span>` : ""}</td>
    </tr>`;
  });
  return `
  <section class="wrap page">
    <div class="head"><h1>File a claim</h1><p>Hurt by a drone, or your things damaged? Claim here. If the drone broke a safety rule you're paid automatically: 5 QOR plus your 1 QOR deposit back. If not, an insurer looks at your proof. A false claim loses its deposit.</p></div>
    ${guide("People hurt by a drone", ["<b>Paste your wallet address</b> (your payout goes there), then send 1.5 test QOR to the filing address the page shows (judges: one click from the demo faucet).", "<b>Click where it happened</b> on the map and say when. The page finds the drone that was there.", "<b>Say what happened</b>, add a photo if you have one, and file. Check back below with your address."])}
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

/** Claims an address filed, read live from QoreChain (newest first): newer than this page's saved data. */
async function liveClaimsOf(addr: string): Promise<(Claim & { txhash: string; height: number; time: string })[]> {
  const q = encodeURIComponent(`message.sender='${addr}'`);
  const r = await fetch(`/api/rest/cosmos/tx/v1beta1/txs?query=${q}&pagination.limit=50&order_by=ORDER_BY_DESC`).then((x) => x.json());
  const out: (Claim & { txhash: string; height: number; time: string })[] = [];
  for (const t of r.tx_responses ?? []) {
    if (t.code !== 0) continue;
    for (const m of t.tx?.body?.messages ?? []) {
      if (!String(m["@type"]).endsWith("MsgPostRollupData") || m.rollup_id !== data.rollup.rollupId) continue;
      const c = parseClaim(Uint8Array.from(atob(m.data), (ch) => ch.charCodeAt(0)));
      if (c) out.push({ ...c, txhash: t.txhash, height: Number(t.height), time: t.timestamp });
    }
  }
  return out;
}

let walletPoll: ReturnType<typeof setInterval> | undefined;
let claimsRetried = false;

function claimsReady() {
  const want = decodeURIComponent(location.hash.split("/")[2] ?? "");
  if (want && !flights.some((f) => f.id === want) && !claimsRetried) {
    claimsRetried = true;
    refreshData().then((changed) => changed && route()).catch(() => undefined);
  }
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
    out.innerHTML = `<p class="found"><i class="spin inline"></i>Reading your claims from QoreChain…</p>`;
    await refreshData().catch(() => false);
    const mine = data.claims.filter((c) => c.victim === addr || c.payTo === addr);
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
    out.innerHTML = `<p class="found"><i class="spin inline"></i>Reading your claims from QoreChain…</p>`;
    let fresh: Awaited<ReturnType<typeof liveClaimsOf>> = [];
    let liveOk = true;
    try {
      fresh = (await liveClaimsOf(addr)).filter((l) => !mine.some((c) => c.flight === l.flight));
    } catch {
      liveOk = false;
    }
    const freshList = fresh.length
      ? `<div class="scroll"><table class="table"><thead><tr><th>Just filed (live from QoreChain)</th><th>Status</th></tr></thead><tbody>${fresh
          .map(
            (l) => `<tr><td>“${esc(l.note)}”<span class="muted block">${claimFlight({ flight: l.flight, victim: addr, note: l.note, status: "open", ...(l.drone ? { drone: l.drone } : {}), ...(l.when ? { when: l.when } : {}) })} · block ${l.height.toLocaleString()} · ${esc(new Date(l.time).toLocaleString())}</span></td>
          <td>${badge("warn", "Received · waiting for the watchtower")}<span class="muted block">It judges claims once they are in a settled batch.</span></td></tr>`,
          )
          .join("")}</tbody></table></div>`
      : "";
    out.innerHTML =
      (mine.length || fresh.length
        ? `<p class="found ok">${mine.length + fresh.length} claim${mine.length + fresh.length > 1 ? "s" : ""} found: <b>${paid} paid</b>, ${mine.filter((c) => c.status === "review").length} with the insurer, ${mine.filter((c) => c.status === "rejected").length} rejected${fresh.length ? `, <b>${fresh.length} just filed</b>` : ""}.${mine.length ? " Judged ones are highlighted below." : ""}${balance}</p>`
        : `<p class="found">No claims from this address on QoreChain.${balance}</p>`) +
      freshList +
      mine.map((c) => `<details class="track-box"${c.status === "paid" && payoutFor(c)?.tx ? "" : " open"}><summary><b>“${esc(c.note)}”</b> ${claimBadge(c)}</summary>${claimTrack(c.flight, c.victim)}</details>`).join("") +
      (liveOk ? "" : `<p class="muted tiny">Couldn't reach QoreChain for claims filed since this page's data was saved.</p>`);
  });
}

/* ---------- file a claim (wallet.ts) ---------- */

const PAY_KEY = "skyproof.payTo";
const savedPayTo = () => {
  try {
    return localStorage.getItem(PAY_KEY) ?? "";
  } catch {
    return "";
  }
};
const QOR_ADDR = /^qor1[02-9ac-hj-np-z]{38,90}$/;

function renderFileBox(w: ClaimWallet | undefined, flight?: string) {
  clearInterval(walletPoll);
  const box = $("#fileBox");
  if (!w) {
    box.innerHTML = `
      <ol class="file-steps">
        <li class="on"><b>Paste your QoreChain address.</b> Your payout and your deposit refund go there. No recovery phrase needed.</li>
        <li><b>Send ${CLAIM_FUNDS_QOR} test QOR</b> to the filing address shown next: a 1 QOR deposit (refunded with your payout) plus the network fee.</li>
        <li><b>Click where it happened, say what happened, and file.</b></li>
      </ol>
      <form id="wStart" class="lookup-row start-row"><input id="wPay" placeholder="qor1… your wallet address" autocomplete="off" spellcheck="false" value="${esc(savedPayTo())}" /><button class="btn primary">Continue</button></form>
      <p class="tiny muted">No wallet of your own? <button type="button" class="linkbtn" id="wNew">Keep the payout in a wallet this page makes</button> · <button type="button" class="linkbtn" id="wHave">Restore an earlier filing wallet</button></p>
      <p class="judge-tip tiny"><b>Judges:</b> no QOR needed. Choose “Keep the payout in a wallet this page makes”, then press <b>Fund it from the demo faucet</b>. Or play every role at once on the <a class="link" href="#/demo">live demo</a>.</p>
      <form id="wRestore" class="file-restore" hidden>
        <label for="wWords" class="muted">Your 24 recovery words</label>
        <textarea id="wWords" rows="2" autocomplete="off" spellcheck="false"></textarea>
        <button class="btn">Restore</button>
      </form>
      <div id="fileOut" aria-live="polite"></div>`;
    $("#wStart").addEventListener("submit", async (e) => {
      e.preventDefault();
      const a = $<HTMLInputElement>("#wPay").value.trim().toLowerCase();
      if (!QOR_ADDR.test(a)) {
        $("#fileOut").innerHTML = `<p class="alert">That doesn't look like a QoreChain address. It starts with <b>qor1</b>.</p>`;
        return;
      }
      try {
        localStorage.setItem(PAY_KEY, a);
      } catch {
        /* remembered only as a convenience */
      }
      renderFileBox(await createWallet(), flight);
    });
    $("#wNew").onclick = async () => {
      try {
        localStorage.removeItem(PAY_KEY);
      } catch {
        /* nothing to forget */
      }
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
  const droneOpts = Object.keys(data.drones).map((d) => `<option value="${esc(d)}">${esc(d)}</option>`).join("");
  box.innerHTML = `
    <div class="wallet">
      <div class="grow"><span class="muted tiny">Filing address: made in this browser to sign your claim with a quantum-safe key (ML-DSA-87). Send ${CLAIM_FUNDS_QOR} test QOR here.</span><b class="mono" id="wAddr">${esc(w.address)}</b></div>
      <button class="btn sm" id="wCopy">Copy</button>
      <span class="badge plain" id="wBal">Checking…</span>
    </div>
    <div class="fund" id="wFund" hidden><p>Send at least <b>${CLAIM_FUNDS_QOR} test QOR</b> to this address: a 1 QOR deposit (you get it back if your claim is right) plus the network fee. This page checks every few seconds.</p>
      <p class="tiny"><button type="button" class="btn sm" id="wFaucet">Judges: fund it from the demo faucet</button> <span class="muted">Sends 1.6 test QOR to this new, empty filing address. Limited per day.</span></p><p class="tiny" id="wFaucetOut"></p></div>
    <form id="claimForm" class="claim-form">
      <div class="q"><span class="q-t">1. Where did it happen?</span><span class="muted q-h">Click the map. The circles are where each registered drone is allowed to fly.</span><button type="button" class="btn sm" id="cGeo">Use my location</button></div>
      <div id="cMap" class="claim-map"></div>
      <p class="tiny muted" id="cPinNote">No place chosen yet.</p>
      <div class="two">
        <label><span>2. When did it happen?</span><input type="datetime-local" id="cWhen" />
          <small class="muted">Demo: ${flightDays()}. <button type="button" class="linkbtn" id="cDemoTime">Use a time a flight was in the air</button></small></label>
        <label><span>3. Did you see the drone's ID? <em class="muted">(optional)</em></span><select id="cDrone"><option value="">No / not sure</option>${droneOpts}</select>
          <small class="muted">Painted on the drone, or shown by a Remote ID app.</small></label>
      </div>
      <fieldset class="match"><legend>4. Which flight?</legend><p class="tiny muted" id="cHint"></p><div id="cMatch"></div></fieldset>
      <label><span>5. What happened?</span><textarea id="cNote" rows="3" maxlength="280" required placeholder="e.g. The parcel fell on my car near the drop point."></textarea></label>
      <label><span>Describe the place <em class="muted">(optional)</em></span><input id="cWhere" maxlength="140" placeholder="e.g. car park behind 12 Main St" />
        <small class="muted">Public in your claim, with the map point. The insurer can compare it with the drone's sealed position log.</small></label>
      <fieldset class="match payto"><legend>6. Where should the payout go?</legend>
        <label class="match-row"><input type="radio" name="cPay" value="own"${savedPayTo() ? " checked" : ""} /><span class="grow"><b>My own QoreChain address</b><input id="cPayTo" placeholder="qor1…" autocomplete="off" spellcheck="false" class="mono" value="${esc(savedPayTo())}" /></span></label>
        <label class="match-row"><input type="radio" name="cPay" value="self"${savedPayTo() ? "" : " checked"} /><span class="grow"><b>The filing address above</b><span class="muted block mono">${esc(w.address)}</span></span></label>
        <small class="muted">The 5 QOR payout and your 1 QOR deposit back both go here.</small>
      </fieldset>
      <label><span>Photo proof <em class="muted">(optional)</em></span><input type="file" id="cPhoto" accept="image/*" />
        <small class="muted">The photo stays on your device. Only its fingerprint (SHA-256) goes on chain, so when you show it to the insurer they can prove it is the same photo you filed.</small>
        <small class="mono" id="cPhotoHash"></small></label>
      <div class="file-actions"><button class="btn primary" id="cSend" disabled>Pay 1 QOR deposit and file claim</button><span class="muted tiny">Deposit refunded with your payout · fees about 0.3 QOR (the first one registers your quantum-safe key)</span></div>
    </form>
    <div id="fileOut" aria-live="polite"></div>
    <details class="wallet-more">
      <summary>Filing wallet options (you don't need these)</summary>
      <p class="muted tiny">Only needed to use this filing address from another browser, or if you chose to keep the payout here. Anyone with these words controls it. Testnet only.</p>
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
  $("#wFaucet").onclick = async () => {
    const out = $("#wFaucetOut");
    $<HTMLButtonElement>("#wFaucet").disabled = true;
    out.innerHTML = `<i class="spin inline"></i>Asking the demo faucet…`;
    try {
      const r = await svc<{ tx: string }>("/fund", { address: w.address });
      out.innerHTML = `✓ Sent by the demo faucet: ${txLink(r.tx)}. The balance updates in a few seconds.`;
      setTimeout(refresh, 4000);
    } catch (e) {
      out.innerHTML = `<span class="alert inline">${esc(e instanceof Error ? e.message : String(e))}</span>`;
      $<HTMLButtonElement>("#wFaucet").disabled = false;
    }
  };
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
  let picked = flight ?? "";
  let pin: { lat: number; lon: number } | undefined;
  /** Drones whose permitted area covers the pin (all drones when no pin). */
  const dronesHere = () => Object.entries(data.drones).filter(([, d]) => !pin || (d.permit && distM(pin, d.permit.area) <= d.permit.area.r)).map(([id]) => id);
  const renderMatch = () => {
    const drone = $<HTMLSelectElement>("#cDrone").value;
    const whenV = $<HTMLInputElement>("#cWhen").value;
    const t = whenV ? new Date(whenV).getTime() : NaN;
    const here = dronesHere();
    const all = flights
      .filter((f) => (!drone || f.segs[0]?.header.drone === drone) && here.includes(f.segs[0]?.header.drone))
      .map((f) => {
        const { start, end } = flightWindow(f);
        const off = Number.isNaN(t) || start === undefined ? 0 : t < start ? start - t : t > end! ? t - end! : 0;
        return { f, start, end, off };
      })
      .sort((a, b) => (Number.isNaN(t) ? (b.start ?? 0) - (a.start ?? 0) : a.off - b.off));
    const cands = all.filter((c) => Number.isNaN(t) || c.off <= 3 * 3600_000);
    // Nothing near that time: still show these drones' flights, nearest first, so the victim sees why.
    const others = cands.length ? [] : all.slice(0, 4);
    const nrDrones = drone ? [drone] : pin && here.length ? here : ["unknown-drone"];
    const nrIds = nrDrones.map(noRecordId);
    if (!picked || ![...cands.map((c) => c.f.id), ...all.slice(0, 4).map((c) => c.f.id), ...nrIds].includes(picked)) picked = cands.find((c) => c.off === 0)?.f.id ?? cands[0]?.f.id ?? nrIds[0];
    const ago = (ms: number) => (ms < 3600_000 ? `${Math.round(ms / 60000)} min` : ms < 48 * 3600_000 ? `${Math.round(ms / 3600_000)} h` : `${Math.round(ms / 86_400_000)} days`);
    const near = (c: (typeof cands)[number]) =>
      Number.isNaN(t) ? "" : c.off === 0 ? badge("ok", "In the air at that time") : badge("plain", `${ago(c.off)} ${c.start! > t ? "after" : "before"} that`);
    const row = (c: (typeof cands)[number]) => `<label class="match-row"><input type="radio" name="cPick" value="${esc(c.f.id)}"${c.f.id === picked ? " checked" : ""} />
          <span class="grow"><b>${esc(c.f.name)}</b><span class="muted block">Drone ${esc(c.f.segs[0]?.header.drone ?? "?")} · allowed over ${esc(FLEET[c.f.segs[0]?.header.drone]?.area ?? "its permit area")} · took off ${c.start ? esc(new Date(c.start).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })) : "—"} · about ${Math.max(1, Math.round((c.end! - c.start!) / 60000))} min in the air</span></span>${near(c)}</label>`;
    $("#cHint").textContent = pin && !Number.isNaN(t)
      ? "Flights of the drones allowed at your spot, closest to that time first."
      : pin
        ? "Flights of the drones allowed at your spot. Add the time to narrow it down."
        : !Number.isNaN(t)
          ? "Flights in the air around that time, anywhere. Click the map to narrow it down."
          : "Click the map or give the time (either is enough) to find the drone.";
    $("#cMatch").innerHTML =
      (cands.length
        ? cands.map(row).join("")
        : `<p class="nomatch">${pin && !here.length ? "No registered drone is allowed to fly at that spot." : `No flight${drone ? ` of ${esc(drone)}` : pin ? " of the drones allowed there" : ""} was in the air within 3 hours of ${esc(new Date(t).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }))}.${others.length ? " Their nearest flights are below; pick one if you got the time wrong." : ""}`}</p>${others.map(row).join("")}`) +
      nrDrones
        .map(
          (d, k) => `<label class="match-row nr"><input type="radio" name="cPick" value="${esc(nrIds[k])}"${picked === nrIds[k] ? " checked" : ""} />
        <span class="grow"><b>My flight isn't listed${d === "unknown-drone" ? "" : `: claim against ${esc(d)}`}</b><span class="muted block">${d === "unknown-drone" ? (pin ? "No drone could be named. The insurer reviews it with what you give." : "Click the map first: the page then names the drones allowed to fly there.") : `${esc(d)} is allowed to fly ${FLEET[d] ? `over ${esc(FLEET[d].area)}` : "there"}. If its operator publishes no record within 30 minutes, the insurer reviews your claim knowing they kept none.`}</span></span></label>`,
        )
        .join("");
    $$<HTMLInputElement>('input[name="cPick"]').forEach((r) => r.addEventListener("change", () => (picked = r.value)));
  };
  $("#cDemoTime").onclick = () => {
    // The newest flight of a drone allowed at the pin (or any), two minutes after take-off, in local time.
    const here = dronesHere();
    const f = [...flights].filter((x) => here.includes(x.segs[0]?.header.drone)).sort((a, b) => (flightTime(b.id)?.getTime() ?? 0) - (flightTime(a.id)?.getTime() ?? 0))[0];
    const at = f && flightTime(f.id);
    if (!at) return;
    const d = new Date(at.getTime() + 60_000);
    const pad = (n: number) => String(n).padStart(2, "0");
    $<HTMLInputElement>("#cWhen").value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    repick();
  };
  const noRecordId = (d: string) => `${d}@${$<HTMLInputElement>("#cWhen").value || "unknown-time"}`;
  if (flight) {
    const f = flights.find((x) => x.id === flight);
    if (f) $<HTMLSelectElement>("#cDrone").value = f.segs[0]?.header.drone ?? "";
  }
  const repick = () => {
    picked = "";
    renderMatch();
  };
  // The map: drone permit areas, and the victim's pin.
  const areas = Object.entries(data.drones).filter(([, d]) => d.permit);
  const map = L.map($("#cMap"), { scrollWheelZoom: false }).setView([19.08, 72.85], 11);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 18, attribution: "&copy; OpenStreetMap contributors" }).addTo(map);
  const COLORS = ["#6d4cff", "#e0533d", "#1b998b", "#f2b134", "#3a86ff"];
  areas.forEach(([id, d], k) => {
    const a = d.permit!.area;
    L.circle([a.lat, a.lon], { radius: a.r, color: COLORS[k % COLORS.length], weight: 2, fillOpacity: 0.08 }).addTo(map).bindTooltip(`${id} · ${FLEET[id]?.area ?? "permit area"}`);
    for (const z of d.permit!.noFly) L.circle([z.lat, z.lon], { radius: z.r, color: "#ff3b30", weight: 1, dashArray: "4", fillOpacity: 0.15 }).addTo(map).bindTooltip("No-fly zone");
  });
  if (areas.length) {
    const pts = areas.flatMap(([, d]) => {
      const a = d.permit!.area;
      const dl = a.r / 111_320;
      const dn = dl / Math.cos((a.lat * Math.PI) / 180);
      return [L.latLng(a.lat - dl, a.lon - dn), L.latLng(a.lat + dl, a.lon + dn)];
    });
    map.fitBounds(L.latLngBounds(pts), { padding: [10, 10] });
  }
  let marker: L.CircleMarker | undefined;
  const setPin = (lat: number, lon: number) => {
    pin = { lat: Math.round(lat * 1e5) / 1e5, lon: Math.round(lon * 1e5) / 1e5 };
    marker?.remove();
    marker = L.circleMarker([pin.lat, pin.lon], { radius: 8, color: "#111", fillColor: "#b9f227", fillOpacity: 1, weight: 2 }).addTo(map);
    const here = dronesHere();
    $("#cPinNote").innerHTML = `Pinned ${pin.lat}, ${pin.lon}. ${here.length ? `Drones allowed to fly here: <b>${here.map(esc).join(", ")}</b>.` : "No registered drone is allowed to fly here."}`;
    repick();
  };
  map.on("click", (e: L.LeafletMouseEvent) => setPin(e.latlng.lat, e.latlng.lng));
  $("#cGeo").onclick = () =>
    navigator.geolocation?.getCurrentPosition(
      (p) => {
        setPin(p.coords.latitude, p.coords.longitude);
        map.setView([p.coords.latitude, p.coords.longitude], 14);
      },
      () => ($("#cPinNote").textContent = "Couldn't get your location. Click the map instead."),
    );
  setTimeout(() => map.invalidateSize(), 50);
  $("#cDrone").addEventListener("change", repick);
  $("#cWhen").addEventListener("change", repick);
  renderMatch();

  let evidence: string | undefined;
  $<HTMLInputElement>("#cPhoto").addEventListener("change", async (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    evidence = f ? await fileFingerprint(f) : undefined;
    $("#cPhotoHash").textContent = evidence ? `Fingerprint: ${evidence}` : "";
  });
  $("#claimForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const flightId = picked;
    const pickedFlight = flights.find((x) => x.id === flightId);
    const drone = pickedFlight?.segs[0]?.header.drone ?? (flightId.includes("@") ? flightId.split("@")[0] : $<HTMLSelectElement>("#cDrone").value);
    const note = $<HTMLTextAreaElement>("#cNote").value.trim();
    const when = $<HTMLInputElement>("#cWhen").value;
    const ownPay = $<HTMLInputElement>('input[name="cPay"][value="own"]').checked;
    const payTo = ownPay ? $<HTMLInputElement>("#cPayTo").value.trim().toLowerCase() : "";
    if (ownPay && !/^qor1[02-9ac-hj-np-z]{38,90}$/.test(payTo)) {
      $("#fileOut").innerHTML = `<p class="alert">That payout address doesn't look like a QoreChain address (qor1…).</p>`;
      return;
    }
    const desc = $<HTMLInputElement>("#cWhere").value.trim();
    const where = [pin ? `${pin.lat},${pin.lon}` : "", desc].filter(Boolean).join(" · ");
    const out = $("#fileOut");
    if (!note) return;
    if (flightId.includes("@") && (!when || (!pin && drone === "unknown-drone"))) {
      out.innerHTML = `<p class="alert">For a flight that isn't listed, say when it happened and click where on the map, so the claim names exactly what to look for.</p>`;
      return;
    }
    if (!data.claimsPool) {
      out.innerHTML = `<p class="alert">Claims are paused: the site's data has no claims pool yet.</p>`;
      return;
    }
    const send = $<HTMLButtonElement>("#cSend");
    send.disabled = true;
    try {
      const claim = { flight: flightId, note, ...(when ? { when } : {}), ...(where ? { where } : {}), ...(evidence ? { evidence } : {}), ...(drone && drone !== "unknown-drone" ? { drone } : {}), ...(payTo && payTo !== w.address ? { payTo } : {}) };
      const r = await fileClaim(client, w, { rollupId: data.rollup.rollupId, poolAccount: data.claimsPool.account, depositUqor: BigInt(data.claimsPool.depositUqor), claim }, (step) => {
        out.innerHTML = `<p class="found"><i class="spin inline"></i>${esc(step)}</p>`;
      });
      const f = flights.find((x) => x.id === flightId);
      out.innerHTML = `<div class="result ok"><span class="icon">✓</span><div><b>Claim filed on QoreChain, with your 1 QOR deposit.</b>
        <span>For “${esc(f?.name ?? `${drone} at ${when.replace("T", " ")} (no published flight)`)}” · block ${r.height.toLocaleString()} · fee ${qor(r.feeUqor.toString())} QOR</span>
        <span class="mono block">${esc(r.txhash)}</span></div></div>
        <p class="muted tiny next">Next: the watchtower opens the sealed record and checks the six rules. Rule broken: 5 QOR plus your deposit go to your payout address. No rule broken: an insurer reviews your claim${evidence ? " (keep your photo to show them)" : ""}. Its progress, live:</p>
        <div id="fileTrack">${claimTrack(flightId, w.address, r.txhash)}</div>`;
      const track = setInterval(async () => {
        const el = document.getElementById("fileTrack");
        if (!el) return clearInterval(track);
        await refreshData().catch(() => false);
        el.innerHTML = claimTrack(flightId, w.address, r.txhash);
      }, 20_000);
      $<HTMLTextAreaElement>("#cNote").value = "";
      $<HTMLInputElement>("#addr").value = payTo || w.address;
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
  const allW = data.batches.flatMap((b) => b.withdrawals.map((w) => ({ ...w, batch: b.index })));
  const paid = Object.entries(data.withdrawalsExecuted ?? {}).map(([i, tx]) => ({ i, tx, w: allW.find((w) => w.index === i) }));
  return `
  <section class="wrap page">
    <div class="head"><h1>Batches, payouts and audit</h1><p>Everything here can be checked live against QoreChain.</p></div>
    ${guide("Judges and developers", ["Press <b>Verify</b> on any batch: your browser checks its settlement receipt on QoreChain.", "See every payout: how much, to whom, from which batch.", "Read the <b>independent audit</b>: each payout matched to a claim that was owed."])}

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
    <div class="card flush"><div class="scroll"><table class="table"><thead><tr><th>Withdrawal</th><th>Paid</th><th>To</th><th>From batch</th><th>Transaction</th></tr></thead>
      <tbody>${paid.map(({ i, tx, w }) => `<tr><td>#${esc(i)}</td><td><b>${w ? `${qor(w.amount)} QOR` : "—"}</b></td><td class="mono">${w ? esc(short(w.recipient)) : "—"}</td><td>${w ? `#${w.batch}` : "—"}</td><td class="mono" title="${esc(tx)}">${esc(short(tx, 10))}</td></tr>`).join("") || `<tr><td colspan="5" class="muted">None yet</td></tr>`}</tbody></table></div></div>

    ${auditSection()}

    <h2 class="sub-h">Fraud caught</h2>
    <div class="card flush"><div class="scroll"><table class="table"><thead><tr><th>Batch</th><th>Penalty</th><th>Transaction</th></tr></thead>
      <tbody>${(data.fraud ?? []).map((f) => `<tr><td>#${esc(f.batch)}</td><td>${qor(f.slashed)} QOR slashed, ${qor(f.burned)} burned</td><td class="mono">${esc(short(f.tx, 12))}</td></tr>`).join("") || `<tr><td colspan="3" class="muted">None</td></tr>`}</tbody></table></div></div>
    <p class="muted note">A rogue second submitter posted a batch paying the whole claims pool to itself. QoreChain re-executed it, upheld the fraud proof and slashed the rogue's bond. The operator then settled an honest batch in its place.</p>

    <details class="card raw"><summary>All ${data.posts.length} rollup posts</summary><div class="scroll"><table class="table">
      <thead><tr><th>#</th><th>Batch</th><th>Kind</th><th>Detail</th></tr></thead>
      <tbody>${data.posts.map((p) => `<tr><td>${p.seq}</td><td>${p.batch}</td><td>${esc(p.kind)}</td><td class="mono">${esc(p.detail)}</td></tr>`).join("")}</tbody>
    </table></div></details>
  </section>`;
}

/** "SKY-001-cheating-…: B4_OVERRIDE" → "Person below, operator dropped anyway: broke Respect a “No”". */
function readableReason(r: string) {
  const [id, ...rest] = r.split(": ");
  const f = flights.find((x) => x.id === id);
  const why = rest.join(": ");
  const codes = why.split(", ").filter((c) => RULE[c]);
  return `${f ? f.name : id}: ${codes.length ? `broke ${codes.map((c) => RULE[c]).join(", ")}` : why}`;
}

/** The independent payout audit: every coin out of the claims pool matched to what was owed. */
function auditSection() {
  const a = data.audit;
  if (!a) return "";
  const bad = a.rows.filter((r) => !r.justified);
  return `<h2 class="sub-h">Independent payout audit</h2>
    <div class="result ${bad.length ? "bad" : "ok"}"><span class="icon">${bad.length ? "✕" : "✓"}</span><div>
      <b>${bad.length ? `${bad.length} payout(s) from the claims pool are NOT justified` : `All ${a.rows.length} payouts from the claims pool are justified`}</b>
      <span>A separate program rebuilt everything from QoreChain on its own (${a.batches} batches, no saved state), worked out what the rules and the insurer allowed, and matched every real withdrawal from the pool against it. Checked ${esc(new Date(a.checkedAt).toLocaleString())}.</span></div></div>
    <div class="card flush"><div class="scroll"><table class="table"><thead><tr><th>Batch</th><th>Paid</th><th>To</th><th>Owed because</th></tr></thead>
      <tbody>${a.rows.map((r) => `<tr><td>#${r.batch}</td><td class="nowrap"><b>${qor(r.amount)} QOR</b></td><td class="mono nowrap">${esc(short(r.recipient))}</td><td>${r.justified ? "" : badge("bad", "Not justified")} ${esc(readableReason(r.reason))}</td></tr>`).join("")}</tbody></table></div></div>
    <p class="muted note">Why this exists: only the watchtower holds the claims pool's key, and QoreChain's qledger accounts take a single key, so the chain would accept a payout the watchtower made up. This audit can't stop that, but it makes it public at once. Anyone can rerun it: <code>npm run audit</code> in <code>rollup/</code>.</p>`;
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
    <div class="head"><h1>Open a sealed record</h1><p>Every flight's full record is on QoreChain, but sealed with ML-KEM-1024, so the public can't see where people live or where the drone went. Only a key holder can open it.</p></div>
    ${guide("Investigators (and judges, with the demo key)", ["Type the demo code <b>skyproof-demo</b> (try a wrong one first: it stays sealed).", "Pick a flight.", "Press <b>Open record</b>: you see the flight in 3D and which rules held."])}
    <div class="inv-who-grid">
      <div class="card inv-who"><b>Investigator</b><span>An aviation authority, police or accident investigator. Holds only a <b>read key</b>: can open any flight's sealed record and see if a rule was broken. <b>Cannot</b> decide claims or move money.</span></div>
      <div class="card inv-who"><b>Insurer</b><span>Holds a read key <b>and</b> a signing key. Opens a record only to decide a claim the rules didn't flag, then signs approve or reject on chain, and that decision moves money. See the <a class="link" href="#/insurer">Insurers</a> page.</span></div>
    </div>
    <div class="card form">
      <label><span>1. Demo code</span><input id="invCode" placeholder="type skyproof-demo" autocomplete="off" spellcheck="false" /></label>
      <span class="muted tiny or">or</span>
      <label><span>Key file</span><input type="file" id="invKey" accept=".json" /></label>
      <label><span>2. Flight</span><select id="invFlight">${flights.map((f) => `<option value="${esc(f.id)}">${esc(f.name)}</option>`).join("")}</select></label>
      <button class="btn primary" id="invOpen" disabled>3. Open record</button>
    </div>
    <p class="muted tiny" id="invKeyNote">For judges: type <code>skyproof-demo</code> to load the demo investigator key (testnet only). Try a wrong code first: the record stays sealed.</p>
    <div id="invOut"></div>
  </section>`;
}

function investigateReady() {
  let key: { address: string; seed: string } | undefined;
  const btn = $<HTMLButtonElement>("#invOpen");
  const out = $("#invOut");
  const code = $<HTMLInputElement>("#invCode");
  code.addEventListener("input", async () => {
    const v = code.value.trim().toLowerCase();
    if (v.length < "skyproof-demo".length) {
      key = undefined;
      btn.disabled = true;
      $("#invKeyNote").innerHTML = `For judges: type <code>skyproof-demo</code> to load the demo investigator key (testnet only). Try a wrong code first: the record stays sealed.`;
      return;
    }
    if (v !== "skyproof-demo") {
      key = undefined;
      btn.disabled = true;
      $("#invKeyNote").innerHTML = `<span class="alert inline">Wrong code. Without the key, the sealed record can't be read by anyone, not even this website.</span>`;
      return;
    }
    try {
      const res = await fetch("demo-investigator.json");
      if (!res.ok) throw new Error("not published");
      const k = await res.json();
      key = { address: k.address, seed: k.mlkem1024Seed };
      btn.disabled = !key.address || !key.seed;
      $("#invKeyNote").innerHTML = `✓ Demo investigator key loaded (<span class="mono">${esc(short(k.address))}</span>). Pick a flight and open it.`;
    } catch {
      $("#invKeyNote").innerHTML = `<span class="alert inline">The demo key isn't published on this site. Load a key file instead.</span>`;
    }
  });
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
  btn.addEventListener("click", async () => {
    if (!key) return;
    try {
      await withBodies();
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
  const practice = practiceClaim();
  const card = (c: Data["claims"][number], i: number) => {
    return `<div class="card review" data-i="${i}">
      <div class="review-head"><div class="grow"><b>“${esc(c.note)}”</b><span class="muted">by <span class="mono">${esc(c.victim)}</span></span></div>${isDemoClaim(c) ? badge("plain", "Judge demo claim") : ""}${c.status === "review" ? badge("warn", "Waiting for you") : claimBadge(c)}</div>
      <div class="kv">
        <div><span>Flight</span><b>${claimFlight(c)}</b></div>
        <div><span>Rules check</span><b>${c.missing ? "Operator published no record of this flight within 30 minutes of the claim" : "No rule broken in the signed record"}</b></div>
        <div><span>When / where (victim says)</span><b>${esc(c.when ?? "—")} · ${esc(c.where ?? "—")}</b></div>
        <div><span>Deposit</span><b>${qor(c.deposit ?? "0")} QOR (kept if you reject)</b></div>
      </div>
      <div class="tamper">
        <span class="grow tiny">${c.evidence ? `Photo fingerprint on chain: <span class="mono">${esc(c.evidence.slice(0, 24))}…</span>` : "No photo filed with this claim."}</span>
        ${c.evidence ? `<label class="btn sm">Check the victim's photo<input type="file" accept="image/*" hidden data-photo="${i}" /></label>` : ""}
        ${c.missing ? "" : `<button class="btn sm" data-open="${i}">Open the flight record</button>`}
      </div>
      <div class="msg-out" id="rv${i}"></div>
      <label class="claim-form"><span>Your reason (stored on chain)</span><input data-reason="${i}" maxlength="280" placeholder="e.g. Photo shows damage at the drop point, matches the flight path." /></label>
      <div class="file-actions"><button class="btn primary" data-decide="${i}" data-approve="1" disabled>Approve: pay 5 QOR + deposit</button><button class="btn" data-decide="${i}" data-approve="0" disabled>Reject: false claim, keep deposit</button></div>
    </div>`;
  };
  return `
  <section class="wrap page">
    <div class="head"><h1>Insurer desk</h1><p>Claims the rules couldn't settle come here: the drone broke no rule, or its operator published no record. A person decides. The decision is signed with a quantum-safe key and the watchtower carries it out.</p></div>
    ${guide("The insurer (judges: use the demo code)", ["Type the demo code <b>skyproof-demo</b>: a practice claim appears, already decided on chain.", "Check the two photos (only the real one matches the fingerprint on chain) and open the sealed flight record. Deciding the practice claim is a dry run.", "Claims <b>you</b> filed on the <a class='link' href='#/demo'>live demo</a> or the claims page show below as “Judge demo claim”. Decide one and it is <b>really signed and posted</b> with the insurer's key."])}
    <div class="card form ins-key">
      <label><span>Demo code (for judges)</span><input id="insCode" placeholder="type skyproof-demo" autocomplete="off" spellcheck="false" /></label>
      <span class="muted tiny" id="insDemoNote">The real insurer key is never published: it could approve fake claims. The demo code lets the SkyProof service sign with it only for judges' own demo claims.</span>
    </div>
    ${practice >= 0 ? `<div id="insPractice" hidden>
      <h2 class="sub-h">Practice claim <span class="muted tiny">(already decided on chain: ${data.claims[practice].decision?.approve ? "approved" : "rejected"})</span></h2>
      <p class="tiny muted">Photos to test with: <a href="demo-photo.png" download>the victim's real photo</a> · <a href="demo-photo-wrong.png" download>a different photo</a></p>
      <div class="list">${card(data.claims[practice], practice)}</div>
    </div>` : ""}
    <div class="card form ins-key">
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

const isDemoClaim = (c: Data["claims"][number]) => !!data.demoWallets?.includes(c.victim);
const practiceClaim = () => data.claims.findIndex((c) => c.decision && c.evidence && !c.missing);

function insurerReady() {
  let keys: SigningKeys | undefined;
  let kem: { address: string; seed: string } | undefined;
  let demo = false;
  const practice = practiceClaim();
  $<HTMLInputElement>("#insCode").addEventListener("input", async (e) => {
    const v = (e.target as HTMLInputElement).value.trim().toLowerCase();
    const note = $("#insDemoNote");
    if (v.length < "skyproof-demo".length) return;
    if (v !== "skyproof-demo") {
      note.innerHTML = `<span class="alert inline">Wrong code.</span>`;
      return;
    }
    try {
      const res = await fetch("demo-investigator.json");
      if (!res.ok) throw new Error("not published");
      const k = await res.json();
      if (!keys) kem = { address: k.address, seed: k.mlkem1024Seed };
      demo = true;
      const box = document.getElementById("insPractice");
      if (box) box.hidden = false;
      $$<HTMLButtonElement>(`[data-decide="${practice}"]`).forEach((b) => (b.disabled = false));
      const mine = data.claims.map((c, i) => [c, i] as const).filter(([c]) => isDemoClaim(c) && c.status === "review");
      for (const [, i] of mine) $$<HTMLButtonElement>(`[data-decide="${i}"]`).forEach((b) => (b.disabled = false));
      note.innerHTML = `✓ Demo mode on. The practice claim below is a dry run.${mine.length ? ` <b>${mine.length} judge demo claim${mine.length > 1 ? "s" : ""}</b> waiting further down: deciding ${mine.length > 1 ? "them" : "it"} posts a real, signed decision.` : ` To decide a real claim on chain, file one on the <a class="link" href="#/demo">live demo</a> with a safe flight.`}`;
      box?.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch {
      note.innerHTML = `<span class="alert inline">The demo key isn't published on this site.</span>`;
    }
  });
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
    btn.addEventListener("click", async () => {
      const i = Number(btn.dataset.open);
      if (!kem) {
        $(`#rv${i}`).innerHTML = `<p class="alert">Load the insurer key file first: it opens the sealed record.</p>`;
        return;
      }
      try {
        await withBodies();
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
      if (!reason) {
        out.innerHTML = `<p class="alert">Write a reason first. It is stored on chain with your decision.</p>`;
        return;
      }
      if (demo && !keys && i !== practice && isDemoClaim(c)) {
        $$<HTMLButtonElement>(`[data-decide="${i}"]`).forEach((b) => (b.disabled = true));
        out.innerHTML = `<p class="found"><i class="spin inline"></i>Signing with the insurer's key and posting the decision…</p>`;
        try {
          const r = await svc<{ tx: string; height?: number }>("/decide", { code: "skyproof-demo", flight: c.flight, victim: c.victim, approve, reason });
          out.innerHTML = `<div class="result ${approve ? "ok" : "bad"}"><span class="icon">${approve ? "✓" : "✕"}</span><div><b>${approve ? "Approved." : "Rejected."} Decision signed with the insurer's key and posted.</b>
            <span>${r.height ? `Block ${r.height.toLocaleString()} · ` : ""}the watchtower ${approve ? "pays the victim" : "keeps the deposit"} on its next check, about a minute.</span><span class="block">${txLink(r.tx)}</span></div></div>`;
        } catch (err) {
          out.innerHTML = `<p class="alert">${esc(err instanceof Error ? err.message : String(err))}</p>`;
          $$<HTMLButtonElement>(`[data-decide="${i}"]`).forEach((b) => (b.disabled = false));
        }
        return;
      }
      if (demo && (i === practice || !keys)) {
        const d = { flight: c.flight, victim: c.victim, approve, reason };
        out.innerHTML = `<div class="result ${approve ? "ok" : "bad"}"><span class="icon">${approve ? "✓" : "✕"}</span><div><b>Demo: ${approve ? "approved" : "rejected"}. Nothing was posted.</b>
          <span>With the real insurer key, this decision is signed (secp256k1 + ML-DSA-87) and posted to rollup <span class="mono">${esc(data.rollup.rollupId)}</span>. The watchtower then ${approve ? `pays the victim 5 QOR plus the ${qor(c.deposit ?? "0")} QOR deposit` : "keeps the deposit"}.</span>
          <span>The real decision on chain for this claim: <b>${c.decision?.approve ? "approved" : "rejected"}</b>, “${esc(c.decision?.reason ?? "")}”</span>
          <pre class="mono tiny">${esc(JSON.stringify(d, null, 2))}</pre></div></div>`;
        return;
      }
      if (!keys) return;
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
  const to = c.payTo ?? c.victim;
  for (const x of data.claims.filter((y) => y.status === "paid" && (y.payTo ?? y.victim) === to)) {
    const xp = data.posts.find((p) => p.kind === "claim" && p.detail === x.flight && p.poster === x.victim);
    for (const b of data.batches) {
      if (xp && b.index <= xp.batch) continue;
      const w = b.withdrawals.find((w) => w.recipient === to && w.index !== undefined && !used.has(w.index));
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
  const pick = flights.find((f) => f.id === tourFlight) ?? flights.find((f) => f.id.includes("-cheating-") && !data.demoFlights?.includes(f.id)) ?? flights[0];
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
    <div class="head"><h1>Guided demo</h1><p>One real drone flight on QoreChain testnet, from take-off to payout, in seven steps.</p></div>
    ${guide("Judges: start here", ["Read the steps top to bottom (about 3 minutes).", "Press each <b>Check</b> button: your browser asks QoreChain directly, so you don't have to trust this page.", "Pick another flight at the top to follow a different story."])}
    <div class="card tour-pick">
      <span class="muted">Follow this flight:</span>
      <div class="seg">${flights.filter((f) => f.id === pick.id || !data.demoFlights?.includes(f.id)).map((f) => `<button class="${f.id === pick.id ? "on" : ""}" data-tf="${esc(f.id)}">${esc(f.name)}</button>`).join("")}</div>
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
          <span>${c?.verdict?.breach ? esc(c.verdict.findings[0] ? plain(c.verdict.findings[0]) : "") : c?.decision ? "The drone followed every rule, so the claim went to the insurer for a human review." : c ? "The claim was rejected: the signed record shows the drone followed every rule." : "Rules are checked when someone claims."}</span></div></div>
         ${c?.decision ? `<div class="result ${c.decision.approve ? "ok" : "bad"}"><span class="icon">${c.decision.approve ? "✓" : "✕"}</span><div><b>Insurer ${c.decision.approve ? "approved" : "rejected"} the claim</b><span>“${esc(c.decision.reason)}” · signed with the insurer's quantum-safe key, on chain</span></div></div>` : ""}
         <div class="rules">${ruleList(broken)}</div>`)}
      ${step(6, "The victim is paid automatically", pay ? `The judge signs a payout from the claims pool${BigInt(c?.deposit ?? "0") > 0n ? ", with the claimant's 1 QOR deposit back" : ""}. QoreChain settles it after the challenge window.` : c ? "No rule was broken, so nothing was paid. A claim filed today would go to the insurer for a human review." : "No claim, no payout.",
        pay ? `<div class="kv"><div><span>Paid</span><b>${qor(pay.amount)} QOR to ${esc(short(c!.victim))}</b></div><div><span>In batch</span><b>${pay.batch}</b></div>${(() => {
              const a = data.audit?.rows.find((r) => r.batch === pay.batch && r.recipient === c!.victim && r.amount === pay.amount);
              return a ? `<div><span>Independent audit</span><b>${a.justified ? "✓ Owed: matched to this claim" : "✕ Not justified"}</b></div>` : "";
            })()}</div>
              ${pay.tx ? `<div class="tour-act"><button class="btn primary" id="tPay" data-tx="${esc(pay.tx)}">Check the payment on QoreChain</button><span class="tiny mono muted">${esc(short(pay.tx, 10))}</span></div><div class="tour-out" id="tPayOut"></div>` : ""}` : "")}
      ${step(7, "A cheater can't steal the claims pool", "A rogue submitter bonded into the rollup and posted a batch whose payout list sent the whole claims pool to itself. The batch was re-run, the fraud was proven on chain, and QoreChain slashed the cheater's bond. Victims' money never moved.",
        fraud ? `<div class="kv"><div><span>Fake batch</span><b>#${esc(fraud.batch)}</b></div><div><span>Cheater lost</span><b>${qor(fraud.slashed)} QOR bond (half burned, half to the challenger)</b></div></div>
          <div class="tour-act"><button class="btn primary" id="tFraud" data-tx="${esc(fraud.tx)}">Check the fraud proof on QoreChain</button><span class="tiny mono muted">${esc(short(fraud.tx, 10))}</span></div><div class="tour-out" id="tFraudOut"></div>` : "")}
    </ol>
    <div class="card tour-next">
      <b>Try each role yourself</b>
      <div class="who-mini">
        <a class="btn primary" href="#/demo">Do it yourself, live on chain</a>
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

/* ---------- the SkyProof service (rollup/src/cli/service.ts on the site's VM) ---------- */

interface SvcStatus {
  ok: boolean;
  lastCycleAt: string;
  cycleMs: number;
  lastError: string;
  busy: string;
  chainHeight?: number;
  inbox?: { head: number; consumed: number };
  latestBatch?: { index: number; status: string };
  faucet?: { address: string; balanceQor: string; perClaimQor: string };
  demo?: { fundedToday: number; fundLimitPerDay: number; flightsToday: number; flightLimitPerDay: number; decisions: number };
}

async function svc<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(`/api/demo${path}`, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : { cache: "no-store" });
  const j = (await r.json().catch(() => ({ error: `the service answered HTTP ${r.status}` }))) as T & { error?: string };
  if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
  return j;
}

/** Re-read the site's data (the service re-exports it from the chain every minute). True when it changed. */
async function refreshData(): Promise<boolean> {
  const res = await fetch("/skyproof.json", { cache: "no-store" });
  if (!res.ok) return false;
  const d = (await res.json()) as Data;
  if (d.generatedAt === data.generatedAt) return false;
  data = d;
  flights = buildFlights(d);
  showGenerated();
  return true;
}
const showGenerated = () => ($("#generated").textContent = `Data read from QoreChain ${new Date(data.generatedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`);

const ago = (iso: string) => {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  return s < 90 ? `${s} s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
};

/** One line on what the always-on service is doing, for the pages judges act on. */
async function svcLine(el: HTMLElement) {
  try {
    const st = await svc<SvcStatus>("/status");
    const fresh = !!st.lastCycleAt && Date.now() - new Date(st.lastCycleAt).getTime() < 3 * (st.cycleMs || 60_000);
    el.className = `svc card ${fresh && st.ok ? "on" : "warn"}`;
    el.innerHTML = `<span class="live-dot ${fresh ? "on" : ""}"></span><span><b>Watchtower ${fresh ? "online" : "delayed"}</b> · last check ${st.lastCycleAt ? ago(st.lastCycleAt) : "not yet"}${st.busy ? ` · now: ${esc(st.busy)}` : ""}${st.latestBatch ? ` · latest batch #${st.latestBatch.index} (${esc(st.latestBatch.status)})` : ""}${st.inbox && st.inbox.head > st.inbox.consumed ? ` · ${st.inbox.head - st.inbox.consumed} post(s) waiting for the next batch` : ""}${st.faucet ? ` · demo faucet ${qor(Math.round(Number(st.faucet.balanceQor) * 1e6))} QOR left` : ""}</span>`;
    return st;
  } catch {
    el.className = "svc card warn";
    el.innerHTML = `<span class="live-dot"></span><span><b>The SkyProof service isn't answering.</b> Demo actions are paused; everything else on this site still reads QoreChain directly.</span>`;
    return undefined;
  }
}

const TX_URL = (h: string) => `https://api-testnet.qore.host/cosmos/tx/v1beta1/txs/${h}`;
const txLink = (h?: string) => (h ? `<a class="link mono" href="${TX_URL(h)}" target="_blank" rel="noopener">${esc(short(h, 6))}</a>` : "");

/** Seconds until a batch leaves its challenge window. */
const finalIn = (b: { submittedTime: number }) => Math.max(0, b.submittedTime + (data.rollup.challengeWindowSec ?? 3600) - (chain?.tipTime ?? Date.now() / 1000));

/** A claim's progress, step by step, from the site's chain data. */
function claimTrack(flight: string, victim: string, filedTx?: string): string {
  const c = data.claims.find((x) => x.flight === flight && x.victim === victim);
  const post = data.posts.find((p) => p.kind === "claim" && p.detail === flight && p.poster === victim);
  const to = c?.payTo ?? victim;
  const pending = data.pendingPayouts?.find((p) => p.recipient === to && p.reason.startsWith(`${flight}:`));
  const pay = c ? payoutFor(c) : undefined;
  const pb = pay ? data.batches.find((b) => b.index === pay.batch) : undefined;
  const steps: ["done" | "now" | "todo" | "bad", string, string][] = [];
  steps.push(["done", "Claim filed on QoreChain, with a 1 QOR deposit", filedTx ? `Transaction ${txLink(filedTx)}` : post ? `Block ${post.height.toLocaleString()}` : ""]);
  steps.push(post ? ["done", `Settled in batch #${post.batch}`, "Every post in the inbox goes into the next batch, so nobody can drop a claim."] : ["now", "Waiting for the next batch", "The service settles waiting posts about once a minute."]);
  if (!c) steps.push(["todo", "The watchtower opens the sealed record and checks the six rules", ""]);
  else if (c.status === "open") steps.push(["now", "Watchtower: waiting for the flight's record", "The operator has 30 minutes to publish it. After that the insurer reviews the claim, knowing there is no record."]);
  else if (c.verdict?.breach) steps.push(["bad", `Rule broken: ${brokenRules(c.verdict).map((r) => esc(RULE[r] ?? r)).join(", ")}`, "The watchtower decided this from the signed record. No person was involved."]);
  else if (c.status === "review") steps.push(["now", c.missing ? "No record published: the insurer decides" : "No rule broken: the insurer decides", "A person reviews the claim and signs approve or reject on chain."]);
  else if (c.decision) {
    steps.push(["done", c.missing ? "No record published: sent to the insurer" : "No rule broken: sent to the insurer", ""]);
    steps.push([c.decision.approve ? "done" : "bad", `Insurer ${c.decision.approve ? "approved" : "rejected"} the claim`, `“${esc(c.decision.reason)}” · signed on chain`]);
  } else steps.push(["bad", "Rejected", "The signed record shows every rule was kept."]);
  if (c?.status === "paid") {
    if (pay && pb) {
      steps.push(["done", `Payout of ${qor(pay.amount)} QOR in batch #${pay.batch}`, `5 QOR from the operator's claims pool plus the deposit back, to <span class="mono">${esc(short(to))}</span>.`]);
      const left = finalIn(pb);
      if (pay.tx) steps.push(["done", "Paid: the QOR is in the wallet", `Withdrawal ${txLink(pay.tx)}`]);
      else if (pb.status === "finalized" || left === 0) steps.push(["now", "Batch final: sending the QOR", "The service executes the withdrawal within a minute."]);
      else steps.push(["now", `Challenge window: payout released in about ${Math.ceil(left / 60)} min`, "For one hour anyone can prove the batch wrong and stop it. Then QoreChain releases the money."]);
    } else steps.push(["now", "Payout signed by the judge: waiting for the next batch", pending ? `Transaction ${txLink(pending.tx)}` : ""]);
  } else if (c?.status !== "rejected") steps.push(["todo", "Payout", "5 QOR plus the deposit back, if a rule was broken or the insurer approves."]);
  return `<ol class="track">${steps.map(([st, t, d]) => `<li class="${st}"><span class="dot"></span><div><b>${t}</b>${d ? `<span class="muted tiny block">${d}</span>` : ""}</div></li>`).join("")}</ol>`;
}

/* ---------- live demo: a judge plays every role, for real, on QoreChain ---------- */

interface DemoRun {
  scenario?: string;
  flight?: string;
  flyTxs?: string[];
  wallet?: ClaimWallet;
  fundTx?: string;
  claimTx?: string;
  note?: string;
  decision?: { approve: boolean; tx: string; reason: string };
}
const RUN_KEY = "skyproof.liveDemo.v1";
const loadRun = (): DemoRun => {
  try {
    return JSON.parse(localStorage.getItem(RUN_KEY) ?? "{}") as DemoRun;
  } catch {
    return {};
  }
};
let run: DemoRun = {};
const saveRun = () => {
  try {
    localStorage.setItem(RUN_KEY, JSON.stringify(run));
  } catch {
    /* the run still works for this visit */
  }
};
const DEMO_SC: { s: string; title: string; what: string; tone: "risky" | "safe" }[] = [
  { s: "cheating", title: "Operator ignores “No”", what: "A person is hit. A rule is broken: the victim is paid automatically.", tone: "risky" },
  { s: "wind", title: "Too windy, flew anyway", what: "The parcel blows onto a car. A rule is broken: paid automatically.", tone: "risky" },
  { s: "normal", title: "Normal delivery", what: "Every rule kept. A claim goes to the insurer: you decide it in step 4.", tone: "safe" },
  { s: "people_below", title: "Someone below, drone waits", what: "The drone waits for the person to leave. No rule broken: you decide as the insurer.", tone: "safe" },
];

function demoPage() {
  run = loadRun();
  const step = (n: number, who: string, title: string, body: string) =>
    `<li class="card tour-step"><div class="tour-n">${n}</div><div class="tour-body"><span class="role-tag">${who}</span><h3>${title}</h3>${body}</div></li>`;
  return `
  <section class="wrap page">
    <div class="head"><h1>Live demo: play every role</h1><p>Everything on this page really happens on QoreChain testnet, now. You fly a drone, get hurt by it, judge the claim and get paid. You don't need a wallet or any QOR: the demo faucet funds a fresh wallet for you.</p></div>
    <div class="svc card" id="svcBox"><span class="live-dot"></span><span>Checking the SkyProof service…</span></div>
    <ol class="tour">
      ${step(1, "Drone operator", "Fly a delivery", `<p class="muted">Pick what happens. The drone signs every part of its log with ML-DSA-87, seals it with ML-KEM-1024 and posts it to the rollup, one transaction per part.</p><div id="d1"></div>`)}
      ${step(2, "Person on the ground", "File a claim against that flight", `<p class="muted">Signed in this browser with a fresh quantum-safe wallet. The faucet sends it 1.6 test QOR: the 1 QOR deposit plus fees.</p><div id="d2"></div>`)}
      ${step(3, "Watchtower", "The rules judge the claim", `<p class="muted">The always-on watchtower settles each batch, opens the sealed record with its key, and checks the six rules. Updates every 15 seconds.</p><div id="d3"></div>`)}
      ${step(4, "Insurer", "Decide the claims the rules can't", `<p class="muted">Only claims with no broken rule come here. Your decision is signed with the insurer's key and posted on chain.</p><div id="d4"></div>`)}
      ${step(5, "Investigator", "Open the sealed record", `<p class="muted">The public sees only ciphertext. The investigator's ML-KEM-1024 key opens it.</p><div id="d5"></div>`)}
      ${step(6, "Person on the ground", "Get paid", `<p class="muted">The payout waits out the rollup's one-hour challenge window, then QoreChain releases it to your wallet. Come back to this page: it remembers your run.</p><div id="d6"></div>`)}
    </ol>
    <div class="card tour-next"><b>Done, or want another story?</b><div class="who-mini"><button class="btn" id="dReset">Start a new run</button><a class="btn" href="#/tour">Guided tour of past flights</a><a class="btn" href="#/proof">Verify every batch</a></div></div>
  </section>`;
}

let demoPoll: ReturnType<typeof setInterval> | undefined;
let demoKem: { address: string; seed: string } | undefined;
function demoReady() {
  const d1 = $("#d1"), d2 = $("#d2"), d3 = $("#d3"), d4 = $("#d4"), d5 = $("#d5"), d6 = $("#d6");
  const busy = (el: HTMLElement, t: string) => (el.innerHTML = `<p class="found"><i class="spin inline"></i>${esc(t)}</p>`);
  const fail = (el: HTMLElement, e: unknown, again?: () => void) => {
    el.innerHTML = `<p class="alert">${esc(e instanceof Error ? e.message : String(e))}</p>${again ? `<button class="btn sm" data-again>Try again</button>` : ""}`;
    if (again) el.querySelector<HTMLButtonElement>("[data-again]")!.onclick = again;
  };
  const claim = () => (run.flight && run.wallet ? data.claims.find((c) => c.flight === run.flight && c.victim === run.wallet!.address) : undefined);

  const render1 = () => {
    if (run.flight) {
      const sc = DEMO_SC.find((x) => x.s === run.scenario);
      const f = flights.find((x) => x.id === run.flight);
      d1.innerHTML = `<div class="result ok"><span class="icon">✓</span><div><b>Flown and posted: “${esc(sc?.title ?? run.scenario ?? "")}”</b>
        <span>Flight <span class="mono">${esc(run.flight)}</span> · ${run.flyTxs?.length ?? 0} transactions${f ? ` · ${f.records} records in ${f.segs.length} signed, sealed parts · ${f.intact ? "signatures valid" : "check failed"}` : " · appears in the flight list after the next batch"}</span>
        <span class="tiny">${(run.flyTxs ?? []).slice(0, 6).map(txLink).join(" · ")}${(run.flyTxs?.length ?? 0) > 6 ? " …" : ""}</span></div></div>
        ${f ? `<p class="tiny"><a class="link" href="#/flights/${encodeURIComponent(f.id)}">See its signed record and tamper test →</a></p>` : ""}`;
      return;
    }
    d1.innerHTML = `<div class="picker demo-pick">${DEMO_SC.map((x) => `<button class="${x.tone}" data-sc="${x.s}"><b>${esc(x.title)}</b><span>${esc(x.what)}</span></button>`).join("")}</div>
      <p class="tiny muted">Takes about a minute: each part is a separate QoreChain transaction.</p>`;
    $$<HTMLButtonElement>("[data-sc]", d1).forEach((b) => (b.onclick = () => fly(b.dataset.sc!)));
  };
  const fly = async (scenario: string) => {
    busy(d1, "Flying and posting each signed, sealed part to QoreChain… (about a minute)");
    try {
      const r = await svc<{ flight: string; txs: string[] }>("/fly", { scenario, drone: "SKY-001" });
      run = { scenario, flight: r.flight, flyTxs: r.txs };
      saveRun();
      renderAll();
    } catch (e) {
      fail(d1, e, render1);
    }
  };

  const render2 = () => {
    if (!run.flight) {
      d2.innerHTML = `<p class="muted tiny">Fly a delivery first (step 1).</p>`;
      return;
    }
    if (run.claimTx) {
      d2.innerHTML = `<div class="result ok"><span class="icon">✓</span><div><b>Claim filed: “${esc(run.note ?? "")}”</b>
        <span>From your demo wallet <span class="mono">${esc(short(run.wallet!.address))}</span> · faucet ${txLink(run.fundTx)} · claim ${txLink(run.claimTx)}</span></div></div>`;
      return;
    }
    if (document.getElementById("dNote")) return;
    d2.innerHTML = `<label class="claim-form"><span>What happened?</span><textarea id="dNote" rows="2" maxlength="280">${esc(run.scenario === "wind" ? "The parcel blew onto my parked car and dented the roof." : "The parcel fell on me near the drop point.")}</textarea></label>
      <div class="file-actions"><button class="btn primary" id="dFile">File my claim on QoreChain</button><span class="muted tiny">Makes a wallet, funds it, registers its ML-DSA-87 key, pays the deposit and files.</span></div><div id="d2out"></div>`;
    $("#dFile").onclick = fileIt;
  };
  const fileIt = async () => {
    const out = $("#d2out");
    const note = $<HTMLTextAreaElement>("#dNote").value.trim() || "Hurt by the drone's parcel.";
    $<HTMLButtonElement>("#dFile").disabled = true;
    try {
      if (!data.claimsPool) throw new Error("The site's data has no claims pool.");
      run.wallet ??= await newWallet();
      saveRun();
      busy(out, "Asking the demo faucet to fund your new wallet…");
      const f = await svc<{ tx: string }>("/fund", { address: run.wallet.address });
      run.fundTx = f.tx;
      saveRun();
      for (let i = 0; i < 30 && (await balanceUqor(run.wallet.address)) < 1_450_000n; i++) await new Promise((r) => setTimeout(r, 3000));
      const r = await fileClaim(client, run.wallet, { rollupId: data.rollup.rollupId, poolAccount: data.claimsPool.account, depositUqor: BigInt(data.claimsPool.depositUqor), claim: { flight: run.flight!, note, drone: "SKY-001" } }, (s) => busy(out, s));
      run.claimTx = r.txhash;
      run.note = note;
      saveRun();
      renderAll();
    } catch (e) {
      fail(out, e);
      const b = document.getElementById("dFile") as HTMLButtonElement | null;
      if (b) b.disabled = false;
    }
  };

  const render3 = () => {
    d3.innerHTML = run.claimTx ? claimTrack(run.flight!, run.wallet!.address, run.claimTx) : `<p class="muted tiny">File the claim first (step 2).</p>`;
  };

  const render4 = () => {
    const c = claim();
    if (run.decision) {
      d4.innerHTML = `<div class="result ${run.decision.approve ? "ok" : "bad"}"><span class="icon">${run.decision.approve ? "✓" : "✕"}</span><div><b>You ${run.decision.approve ? "approved" : "rejected"} the claim, signed with the insurer's key</b><span>“${esc(run.decision.reason)}” · ${txLink(run.decision.tx)} · the watchtower carries it out on its next check.</span></div></div>`;
      return;
    }
    if (!c) {
      d4.innerHTML = `<p class="muted tiny">${run.claimTx ? "Waiting for the watchtower to judge your claim (step 3)." : "Nothing to decide yet."}</p>`;
      return;
    }
    if (c.verdict?.breach) {
      d4.innerHTML = `<div class="result ok"><span class="icon">✓</span><div><b>Nothing for the insurer to do</b><span>The signed record proves a rule was broken, so the watchtower paid without asking anyone. Start a new run with a safe flight to try the insurer's side.</span></div></div>`;
      return;
    }
    if (c.status !== "review") {
      d4.innerHTML = `<p class="muted tiny">This claim is ${esc(c.status)}.</p>`;
      return;
    }
    if (document.getElementById("dReason")) return;
    d4.innerHTML = `<p class="tiny">The flight broke no rule, so you, the insurer, decide. <a class="link" href="#/insurer">The full insurer desk</a> also checks the victim's photo.</p>
      <label class="claim-form"><span>Your reason (stored on chain)</span><input id="dReason" maxlength="140" value="Demo: reviewed the sealed record and the victim's account." /></label>
      <div class="file-actions"><button class="btn primary" data-ap="1">Approve: pay 5 QOR + deposit</button><button class="btn" data-ap="0">Reject: keep the deposit</button></div><div id="d4out"></div>`;
    $$<HTMLButtonElement>("[data-ap]", d4).forEach(
      (b) =>
        (b.onclick = async () => {
          const approve = b.dataset.ap === "1";
          const reason = $<HTMLInputElement>("#dReason").value.trim();
          $$<HTMLButtonElement>("[data-ap]", d4).forEach((x) => (x.disabled = true));
          busy($("#d4out"), "Signing the decision with the insurer's key and posting it…");
          try {
            const r = await svc<{ tx: string; reason: string }>("/decide", { code: "skyproof-demo", flight: run.flight, victim: run.wallet!.address, approve, reason });
            run.decision = { approve, tx: r.tx, reason: r.reason };
            saveRun();
            renderAll();
          } catch (e) {
            fail($("#d4out"), e);
            $$<HTMLButtonElement>("[data-ap]", d4).forEach((x) => (x.disabled = false));
          }
        }),
    );
  };

  const render5 = () => {
    const f = run.flight ? flights.find((x) => x.id === run.flight) : undefined;
    if (!f) {
      d5.dataset.open = "";
      d5.innerHTML = `<p class="muted tiny">${run.flight ? "Available once the flight is settled in a batch (about a minute)." : "Fly a delivery first."}</p>`;
      return;
    }
    if (d5.dataset.open === f.id) return;
    d5.dataset.open = f.id;
    d5.innerHTML = `<div class="file-actions"><button class="btn" id="dOpen">Open it with the demo investigator key</button><span class="muted tiny">Decrypts in your browser. The site never holds the plain record.</span></div><div id="d5out"></div>`;
    $("#dOpen").onclick = async () => {
      try {
        if (!demoKem) {
          const k = await fetch("demo-investigator.json").then((x) => x.json());
          demoKem = { address: k.address, seed: k.mlkem1024Seed };
        }
        await withBodies();
        const r = openFlight(data as unknown as InvestigatorData, f.id, demoKem);
        $("#d5out").innerHTML = `<div class="inv-mini"><div class="result ${r.verdict.breach ? "bad" : "ok"}"><span class="icon">${r.verdict.breach ? "✕" : "✓"}</span><div><b>${r.verdict.breach ? "Rule broken" : "No rule broken"}</b><span>${r.segments} sealed parts opened · ${r.recs.length} records${r.errors.length ? ` · problems: ${esc(r.errors.join("; "))}` : " · every part matches the drone's signature"}</span></div></div>
          <div class="rules">${ruleList(brokenRules(r.verdict))}</div>${r.permit ? `<div class="mapbox">${drawFlight(r.recs, r.permit, r.verdict)}</div>` : ""}</div>`;
      } catch (e) {
        fail($("#d5out"), e);
      }
    };
  };

  const render6 = async () => {
    if (!run.wallet || !run.claimTx) {
      d6.innerHTML = `<p class="muted tiny">Your payout shows here.</p>`;
      return;
    }
    const c = claim();
    const pay = c ? payoutFor(c) : undefined;
    let bal = "…";
    try {
      bal = qor((await balanceUqor(run.wallet.address)).toString());
    } catch {
      /* shown as … */
    }
    d6.innerHTML = `<div class="kv"><div><span>Your demo wallet</span><b class="mono">${esc(short(run.wallet.address))}</b></div><div><span>Balance now, read live</span><b>${bal} QOR</b></div>
      <div><span>Outcome</span><b>${c?.status === "paid" ? (pay?.tx ? `Paid ${qor(pay.amount)} QOR ✓` : "Payout approved, waiting for the challenge window") : c?.status === "rejected" ? "Rejected: no payout, deposit kept" : "Not decided yet"}</b></div></div>
      ${pay?.tx ? `<p class="found ok">✓ ${qor(pay.amount)} QOR arrived: 5 QOR compensation plus your 1 QOR deposit back. Withdrawal ${txLink(pay.tx)}.</p>` : ""}`;
  };

  const renderAll = () => {
    render1();
    render2();
    render3();
    render4();
    render5();
    render6();
  };
  renderAll();
  $("#dReset").onclick = () => {
    run = {};
    saveRun();
    renderAll();
    d1.scrollIntoView({ behavior: "smooth", block: "center" });
  };
  const tick = async () => {
    if (!document.getElementById("d3")) return clearInterval(demoPoll);
    await svcLine($("#svcBox"));
    if (await refreshData().catch(() => false)) renderAll();
    else {
      render3();
      render6();
    }
  };
  clearInterval(demoPoll);
  tick();
  demoPoll = setInterval(tick, 15_000);
}

/* ---------- operator console ---------- */

const claimCost = claimPaid;

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
    const cost = c.status === "paid" ? `${qor(claimCost(c).toString())} QOR paid` : c.status === "rejected" ? "Nothing paid" : `Up to ${qor(claimCost(c).toString())} QOR`;
    return `<tr><td>“${esc(c.note)}”<span class="muted block">${esc(short(c.victim))}${c.height ? ` · block ${c.height.toLocaleString()}` : ""}</span></td>
      <td>${claimFlight(c)}</td><td>${claimBadge(c)}</td><td>${cost}</td></tr>`;
  });
  const stats: [string, string, string][] = [
    ["opBond", `${qor(data.rollup.stakeAmount)} QOR`, "bond locked in the rollup"],
    ["", `${Object.keys(data.drones).length} · ${flights.length}`, "drones · flights on record"],
    ["", `${pending.length}`, `claims pending (up to ${qor(exposure.toString())} QOR)`],
    ["", `${paid.length} · ${qor(paid.reduce((s, c) => s + claimCost(c), 0n).toString())} QOR`, "claims paid · total"],
  ];
  return `
  <section class="wrap page">
    <div class="head"><h1>Operator console</h1><p>Everything QoreChain holds about this operator's drones. Nobody can edit any of it, not even the operator.</p></div>
    ${guide("Drone operators", ["<b>Fly a demo flight</b> below: every part is signed, sealed and posted to QoreChain.", "Watch the rollup's inbox live: each new flight part appears as it is posted.", "See your drones, every flight they signed, and the claims against you with what they cost."])}
    <div class="card op-id">
      <div class="grow"><span class="muted tiny">Operator (rollup creator)</span><b class="mono">${esc(op)}</b></div>
      ${badge(data.rollup.status === "active" ? "ok" : "warn", `Rollup ${data.rollup.rollupId} · ${data.rollup.status}`)}
      ${slashed ? badge("ok", `A rogue submitter was slashed ${qor(slashed)} QOR; your pool was never touched`) : ""}
    </div>
    <div class="stats op-stats">${stats.map(([id, v, k]) => `<div><b${id ? ` id="${id}"` : ""}>${esc(v)}</b><span>${esc(k)}</span></div>`).join("")}</div>

    <h2 class="sub-h">Fly a demo flight now</h2>
    <div class="card op-fly">
      <p class="muted tiny">Be this operator: one of its drones flies a delivery, and every part of the log is signed (ML-DSA-87), sealed (ML-KEM-1024) and posted to QoreChain as its own transaction. Watch the parts arrive in the live activity below. Then file a claim on it, or play every role on the <a class="link" href="#/demo">live demo</a>.</p>
      <div class="lookup-row op-fly-row">
        <select id="opSc" aria-label="What happens">${DEMO_SC.map((x) => `<option value="${x.s}">${esc(x.title)}</option>`).join("")}</select>
        <select id="opDrone" aria-label="Drone">${Object.keys(data.drones).filter((d) => FLEET[d]).map((d) => `<option value="${esc(d)}">${esc(d)} · ${esc(FLEET[d].area.split(",")[0])}</option>`).join("")}</select>
        <button class="btn primary" id="opFly">Fly it on QoreChain</button>
      </div>
      <div id="opFlyOut" aria-live="polite"></div>
    </div>

    <h2 class="sub-h">Live chain activity <span class="live-dot" id="opLiveDot"></span></h2>
    <div class="card op-live">
      <p class="muted tiny" id="opLiveNote">Reading the rollup's inbox on QoreChain…</p>
      <div class="scroll"><table class="table"><thead><tr><th>Post</th><th>From</th><th>Size</th><th>Block</th></tr></thead><tbody id="opLive"></tbody></table></div>
      <p class="muted tiny">Every message to the rollup in order, read live from the chain every 10 seconds. A drone in the air posts a signed, sealed part of its flight every few seconds (fly one above to see it arrive).</p>
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
  $("#opFly").addEventListener("click", async () => {
    const btn = $<HTMLButtonElement>("#opFly");
    const out = $("#opFlyOut");
    const scenario = $<HTMLSelectElement>("#opSc").value;
    btn.disabled = true;
    out.innerHTML = `<p class="found"><i class="spin inline"></i>Flying and posting each signed, sealed part to QoreChain… (about a minute)</p>`;
    try {
      const r = await svc<{ flight: string; txs: string[]; drone: string }>("/fly", { scenario, drone: $<HTMLSelectElement>("#opDrone").value });
      out.innerHTML = `<div class="result ok"><span class="icon">✓</span><div><b>Flight posted: ${r.txs.length} transactions</b>
        <span>Flight <span class="mono">${esc(r.flight)}</span> · drone ${esc(r.drone)} · it joins the flight log after the next batch (about a minute).</span>
        <span class="tiny">${r.txs.slice(0, 6).map(txLink).join(" · ")}${r.txs.length > 6 ? " …" : ""}</span></div></div>
        <p class="tiny"><a class="link" href="#/claims/${encodeURIComponent(r.flight)}">File a claim on this flight →</a></p>`;
    } catch (e) {
      out.innerHTML = `<p class="alert">${esc(e instanceof Error ? e.message : String(e))}</p>`;
    } finally {
      btn.disabled = false;
    }
  });
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
  demo: [demoPage, demoReady],
};

function route() {
  const name = location.hash.replace(/^#\/?/, "").split("/")[0];
  const page = name in pages ? name : "";
  const [render, ready] = pages[page];
  disposeArenas();
  $("#app").innerHTML = render();
  ready?.();
  $$(".links a").forEach((a) => a.classList.toggle("on", a.dataset.r === page));
  $("#moreMenu").classList.toggle("on", ["flights", "investigate", "proof"].includes(page));
  ($("#moreMenu") as HTMLDetailsElement).open = false;
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
  // The service re-exports the data from the chain every minute; pages read it when they render.
  setInterval(() => refreshData().catch(() => undefined), 60_000);
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
  showGenerated();
  $("#menu").addEventListener("click", () => {
    const open = document.body.classList.toggle("menu-open");
    $("#menu").setAttribute("aria-expanded", String(open));
  });
  window.addEventListener("hashchange", route);
  route();
  live();
}

main();
