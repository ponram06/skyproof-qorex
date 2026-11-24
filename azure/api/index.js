/**
 * Narrow proxy to QoreChain testnet for the website on Azure Static Web Apps
 * (the testnet API sends no CORS headers). Same rules as api/proxy.ts on
 * Vercel: GET only the paths the page reads; POST only to simulate or
 * broadcast a transaction the visitor's browser already signed, with a size
 * cap. It holds no keys.
 */
const { app } = require("@azure/functions");

const UPSTREAM = { rest: "https://api-testnet.qore.host", rpc: "https://rpc-testnet.qore.host" };
const ALLOWED = {
  rest: /^\/(qorechain\/(rdk|pqc|multilayer)\/v1\/|cosmos\/(tx\/v1beta1\/txs\/|auth\/v1beta1\/accounts\/|bank\/v1beta1\/balances\/|upgrade\/v1beta1\/applied_plan\/|base\/tendermint\/v1beta1\/))/,
  rpc: /^\/(status|block)$/,
};
const POST_ALLOWED = /^\/cosmos\/tx\/v1beta1\/(simulate|txs)$/;
const MAX_BODY = 64 * 1024;

async function forward(kind, req) {
  const path = "/" + (req.params.path ?? "").replace(/^\/+/, "");
  if (req.method === "POST") {
    if (kind !== "rest" || !POST_ALLOWED.test(path)) return { status: 404, body: "not found" };
    const body = await req.text();
    if (body.length > MAX_BODY) return { status: 413, body: "too large" };
    const upstream = await fetch(UPSTREAM.rest + path, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body });
    return { status: upstream.status, body: await upstream.text(), headers: { "content-type": upstream.headers.get("content-type") ?? "application/json", "cache-control": "no-store" } };
  }
  if (!ALLOWED[kind].test(path) || path.includes("..")) return { status: 404, body: "not found" };
  const qs = new URL(req.url).search;
  const upstream = await fetch(UPSTREAM[kind] + path + qs, { headers: { accept: "application/json" } });
  return {
    status: upstream.status,
    body: await upstream.text(),
    headers: { "content-type": upstream.headers.get("content-type") ?? "application/json", "cache-control": "public, max-age=5" },
  };
}

for (const kind of ["rest", "rpc"]) {
  app.http(`proxy-${kind}`, { methods: ["GET", "POST"], authLevel: "anonymous", route: `${kind}/{*path}`, handler: (req) => forward(kind, req) });
}
