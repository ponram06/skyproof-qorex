/**
 * SkyProof's always-on service, run on the website's VM next to nginx.
 *
 * Every cycle (about a minute) it does, in order, what the README's manual
 * steps do:
 *   1. settle a batch when posts are waiting in the inbox (operator, ML-DSA-87 anchored);
 *   2. run the watchtower (judge): check every new batch's roots, judge claims, post payouts;
 *   3. execute the withdrawals of finalized batches, so payouts reach the victim's wallet;
 *   4. re-export the website's data (skyproof.json) from the chain.
 *
 * It also serves a small API for the judges' demo (nginx proxies /api/demo/ here):
 *   GET  /api/demo/status                       what the service did last, and its accounts
 *   POST /api/demo/fund    {address}            send a fresh filing wallet the test QOR to file one claim
 *   POST /api/demo/fly     {scenario, drone?}   fly a demo delivery now, as the drone operator
 *   POST /api/demo/decide  {code, flight, victim, approve, reason}
 *        the insurer's decision on a claim in review, signed with the insurer's key,
 *        but only for a claim filed from a wallet this service funded (a judge's own claim)
 *
 * Every chain write goes through one queue, so two transactions from one account never race.
 * Usage: service   (env: PORT, SKYPROOF_WEB_OUT, DEMO_CODE)
 */
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { isCanonicalQorAddress } from "@qorechain/rdk";
import { ensurePqcRegistered } from "@qorechain/sdk";
import { connect, txLine, type RoleClient } from "../chain.js";
import { rdk, ROLLUP_ID, toQor } from "../config.js";
import { decisionPost } from "../flight/posts.js";
import { FLEET } from "../flight/fleet.js";
import { load, save } from "../state.js";
import type { WatchState } from "../watchtower.js";

const PORT = Number(process.env.PORT ?? 8787);
const CYCLE_MS = 60_000;
const DEMO_CODE = process.env.DEMO_CODE ?? "skyproof-demo";
/** One claim: the 1 QOR deposit, the one-time ML-DSA-87 key registration (~0.22 QOR) and the claim's fee, with headroom. */
const FUND_UQOR = 1_600_000n;
const DAY = 86_400_000;
const LIMITS = { fundPerIp: 4, fundPerDay: 40, flyPerIp: 6, flyPerDay: 40, decidePerIp: 10 };
const SCENARIOS = ["normal", "people_below", "cheating", "wind"];

interface DemoLog {
  funded: Record<string, { at: number; ip: string; tx: string; toppedUp?: string }>;
  flights: { at: number; ip: string; flight: string; scenario: string; drone: string }[];
  decisions: { at: number; ip: string; flight: string; victim: string; approve: boolean; tx: string }[];
}
const demo = load<DemoLog>("demo", { funded: {}, flights: [], decisions: [] });
const saveDemo = () => save("demo", demo);

const status = {
  startedAt: new Date().toISOString(),
  cycles: 0,
  lastCycleAt: "",
  lastCycleMs: 0,
  lastError: "",
  lastSteps: [] as string[],
  busy: "",
};

/* ---------- one queue per signing account ---------- */

// The operator, judge and victim accounts sign in the cycle and in demo flights: one shared queue.
// The faucet and the insurer sign only for the demo API: each has its own, so judges never wait on a cycle.
const tails: Record<string, Promise<unknown>> = {};
const tailOf = (q: string) => tails[q] ?? Promise.resolve();
let tail: Promise<unknown> = Promise.resolve();
function exclusive<T>(label: string, fn: () => Promise<T>, queue = "main"): Promise<T> {
  const run = tailOf(queue).then(async () => {
    if (queue === "main") status.busy = label;
    try {
      return await fn();
    } finally {
      if (queue === "main") status.busy = "";
    }
  });
  tails[queue] = run.catch(() => undefined);
  tail = Promise.all(Object.values(tails));
  return run;
}

/** Run one of the CLI scripts as its own process (they are the audited code paths). */
function cli(script: string, args: string[] = [], timeoutMs = 300_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ["--import", "tsx", `src/cli/${script}.ts`, ...args], { cwd: process.cwd(), env: process.env });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    const t = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
    p.on("close", (code) => {
      clearTimeout(t);
      const text = out.trim();
      if (code === 0) resolve(text);
      else reject(new Error(`${script} exited ${code}: ${text.split("\n").slice(-3).join(" ")}`));
    });
  });
}

/* ---------- the cycle ---------- */

async function cycle() {
  const t0 = Date.now();
  const steps: string[] = [];
  try {
    const inbox = await rdk.rest.getInbox(ROLLUP_ID);
    if (Number(inbox.headSequence) > Number(inbox.consumedSequence)) steps.push(await cli("submit-batch"));
    steps.push(await cli("watchtower"));
    const w = await cli("withdraw");
    if (w) steps.push(w);
    steps.push(await cli("export-web"));
    status.lastError = "";
  } catch (e) {
    status.lastError = `${new Date().toISOString()} ${e instanceof Error ? e.message : String(e)}`;
    console.error(status.lastError);
  }
  status.cycles++;
  status.lastCycleAt = new Date().toISOString();
  status.lastCycleMs = Date.now() - t0;
  status.lastSteps = steps.flatMap((s) => s.split("\n")).filter(Boolean).slice(-25);
  if (steps.length) console.log(`[${status.lastCycleAt}] ${status.lastSteps.join(" | ")}`);
}

let timer: ReturnType<typeof setTimeout> | undefined;
let cycling = false;
let stopping = false;
function schedule(ms: number) {
  clearTimeout(timer);
  if (stopping) return;
  timer = setTimeout(async () => {
    if (stopping) return;
    if (cycling) return schedule(5_000);
    cycling = true;
    await exclusive("cycle", cycle).catch(() => undefined);
    cycling = false;
    schedule(CYCLE_MS);
  }, ms);
}

/* ---------- accounts ---------- */

let faucet: RoleClient | undefined;
let insurer: RoleClient | undefined;
async function faucetClient() {
  if (!faucet) {
    faucet = await connect("faucet");
    if (!faucet.pqcRegistered) {
      await ensurePqcRegistered(faucet.tx, { pqcKeypair: faucet.pqcKeypair, rest: rdk.network.endpoints.rest });
      faucet = await connect("faucet");
    }
  }
  return faucet;
}
const insurerClient = async () => (insurer ??= await connect("insurer"));

/* ---------- the API ---------- */

const recent = <T extends { at: number; ip: string }>(xs: T[], ip?: string) => xs.filter((x) => Date.now() - x.at < DAY && (!ip || x.ip === ip)).length;
const fundedList = () => Object.values(demo.funded);

class HttpError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let s = "";
  for await (const chunk of req) {
    s += chunk;
    if (s.length > 4096) throw new HttpError(413, "request too large");
  }
  try {
    const j = JSON.parse(s || "{}");
    if (j && typeof j === "object") return j as Record<string, unknown>;
  } catch {
    /* fall through */
  }
  throw new HttpError(400, "send a JSON object");
}

async function getStatus() {
  const f = await faucetClient().catch(() => undefined);
  const [inbox, latest, tip] = await Promise.all([
    rdk.rest.getInbox(ROLLUP_ID).catch(() => undefined),
    rdk.rest.getLatestBatch(ROLLUP_ID).catch(() => undefined),
    rdk.getChainTip().catch(() => undefined),
  ]);
  const faucetBal = f ? await rdk.rest.getBalance(f.address).catch(() => "0") : "0";
  return {
    ok: !status.lastError,
    ...status,
    cycleMs: CYCLE_MS,
    chainHeight: tip?.height,
    inbox: inbox ? { head: Number(inbox.headSequence), consumed: Number(inbox.consumedSequence) } : undefined,
    latestBatch: latest ? { index: latest.batchIndex, status: latest.status, submittedAt: latest.submittedAt } : undefined,
    faucet: f ? { address: f.address, balanceQor: toQor(faucetBal), perClaimQor: toQor(FUND_UQOR) } : undefined,
    insurer: (await insurerClient().catch(() => undefined))?.address,
    demo: {
      fundedToday: recent(fundedList()),
      fundLimitPerDay: LIMITS.fundPerDay,
      flightsToday: recent(demo.flights),
      flightLimitPerDay: LIMITS.flyPerDay,
      decisions: demo.decisions.length,
    },
  };
}

async function fund(ip: string, b: Record<string, unknown>) {
  const address = String(b.address ?? "").trim().toLowerCase();
  if (!isCanonicalQorAddress(address)) throw new HttpError(400, "That is not a QoreChain address (qor1…).");
  const before = demo.funded[address];
  if (before) {
    // A wallet the faucet funded before may top up once, back to one claim's worth.
    const bal = BigInt(await rdk.rest.getBalance(address));
    if (before.toppedUp || bal >= FUND_UQOR - 300_000n) return { address, tx: before.tx, already: true };
    return exclusive(
      "top-up",
      async () => {
        const f = await faucetClient();
        const tx = txLine(`faucet top-up: ${toQor(FUND_UQOR - bal)} QOR to ${address}`, await f.tx.bankSend(address, [{ denom: "uqor", amount: (FUND_UQOR - bal).toString() }], { fee: "auto" }));
        demo.funded[address] = { ...before, toppedUp: tx };
        saveDemo();
        return { address, tx, amountQor: toQor(FUND_UQOR - bal) };
      },
      "faucet",
    );
  }
  if (recent(fundedList(), ip) >= LIMITS.fundPerIp) throw new HttpError(429, `This network already got ${LIMITS.fundPerIp} demo wallets funded today.`);
  if (recent(fundedList()) >= LIMITS.fundPerDay) throw new HttpError(429, "Today's demo funding is used up. Try again tomorrow.");
  const bal = BigInt(await rdk.rest.getBalance(address));
  if (bal > 0n) throw new HttpError(400, `This wallet already holds ${toQor(bal)} QOR. The demo faucet only funds new, empty filing wallets.`);
  return exclusive("fund", async () => {
    const f = await faucetClient();
    const r = await f.tx.bankSend(address, [{ denom: "uqor", amount: FUND_UQOR.toString() }], { fee: "auto" });
    const tx = txLine(`faucet: ${toQor(FUND_UQOR)} QOR to ${address}`, r);
    demo.funded[address] = { at: Date.now(), ip, tx };
    saveDemo();
    return { address, tx, amountQor: toQor(FUND_UQOR), height: r.height };
  }, "faucet");
}

async function fly(ip: string, b: Record<string, unknown>) {
  const scenario = String(b.scenario ?? "");
  const drone = String(b.drone ?? "SKY-001");
  if (!SCENARIOS.includes(scenario)) throw new HttpError(400, `scenario must be one of ${SCENARIOS.join(", ")}`);
  if (!FLEET[drone]) throw new HttpError(400, `drone must be one of ${Object.keys(FLEET).join(", ")}`);
  if (recent(demo.flights, ip) >= LIMITS.flyPerIp) throw new HttpError(429, `This network already flew ${LIMITS.flyPerIp} demo flights today.`);
  if (recent(demo.flights) >= LIMITS.flyPerDay) throw new HttpError(429, "Today's demo flights are used up. Try again tomorrow.");
  const out = await exclusive("fly", () => cli("fly", [scenario, "--drone", drone]));
  const flight = out.match(/^flight (\S+):/m)?.[1];
  if (!flight) throw new HttpError(500, "The flight did not post.");
  const txs = [...out.matchAll(/: ([0-9A-F]{64})/g)].map((m) => m[1]);
  demo.flights.push({ at: Date.now(), ip, flight, scenario, drone });
  saveDemo();
  schedule(1_000); // settle it in a batch right away
  return { flight, scenario, drone, txs };
}

async function decideClaim(ip: string, b: Record<string, unknown>) {
  if (String(b.code ?? "").trim() !== DEMO_CODE) throw new HttpError(403, "Wrong demo code.");
  const flight = String(b.flight ?? "");
  const victim = String(b.victim ?? "").toLowerCase();
  const approve = b.approve === true;
  const reason = String(b.reason ?? "").trim().slice(0, 140) || (approve ? "Demo: approved by the judge acting as insurer" : "Demo: rejected by the judge acting as insurer");
  if (recent(demo.decisions, ip) >= LIMITS.decidePerIp) throw new HttpError(429, "Too many demo decisions from this network today.");
  const c = load<{ watch?: WatchState }>("watchtower", {}).watch?.claims.find((x) => x.flight === flight && x.victim === victim);
  if (!c) throw new HttpError(404, "No such claim yet. If you just filed it, wait for the watchtower's next check (about a minute).");
  if (!demo.funded[victim]) throw new HttpError(403, "The demo code only decides claims filed from a wallet the demo faucet funded (your own demo claim). Real claims need the real insurer.");
  if (c.status !== "review") throw new HttpError(409, `This claim is ${c.status}, not waiting for the insurer.`);
  if (c.decision || demo.decisions.some((d) => d.flight === flight && d.victim === victim)) throw new HttpError(409, "This claim is already decided.");
  return exclusive("decide", async () => {
    const ins = await insurerClient();
    const r = await ins.rdkTx.postRollupData({ rollupId: ROLLUP_ID, data: decisionPost({ flight, victim, approve, reason }) }, { fee: "auto" });
    const tx = txLine(`insurer ${approve ? "approved" : "rejected"} ${flight} for ${victim}`, r);
    demo.decisions.push({ at: Date.now(), ip, flight, victim, approve, tx });
    saveDemo();
    schedule(1_000);
    return { tx, height: r.height, approve, reason };
  }, "insurer");
}

const send = (res: ServerResponse, code: number, j: unknown) => {
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(j));
};

createServer(async (req, res) => {
  const ip = String(req.headers["x-real-ip"] ?? req.socket.remoteAddress ?? "?");
  const path = (req.url ?? "").split("?")[0].replace(/^\/api\/demo/, "");
  try {
    if (req.method === "GET" && path === "/status") return send(res, 200, await getStatus());
    if (req.method === "POST" && path === "/fund") return send(res, 200, await fund(ip, await body(req)));
    if (req.method === "POST" && path === "/fly") return send(res, 200, await fly(ip, await body(req)));
    if (req.method === "POST" && path === "/decide") return send(res, 200, await decideClaim(ip, await body(req)));
    send(res, 404, { error: "not found" });
  } catch (e) {
    const code = e instanceof HttpError ? e.code : 500;
    send(res, code, { error: e instanceof Error ? e.message : String(e) });
  }
}).listen(PORT, "127.0.0.1", () => console.log(`SkyProof service on 127.0.0.1:${PORT}, rollup ${ROLLUP_ID}`));

schedule(2_000);

// A restart must never cut a chain write in half (a batch submitted but not saved, say):
// stop scheduling, let the queue drain, then exit. systemd (KillMode=mixed) waits for this.
for (const sig of ["SIGTERM", "SIGINT"] as const)
  process.on(sig, async () => {
    if (stopping) return;
    stopping = true;
    clearTimeout(timer);
    console.log(`${sig}: finishing ${status.busy || "nothing"} before exit`);
    await tail;
    process.exit(0);
  });
