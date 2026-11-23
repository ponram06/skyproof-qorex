/**
 * Read-only proxy to QoreChain testnet for the website on Azure Static Web
 * Apps (the testnet API sends no CORS headers). Same rules as api/proxy.ts on
 * Vercel: GET only, and only the paths the page reads, so it cannot broadcast
 * transactions or act as an open proxy.
 */
const { app } = require("@azure/functions");

const UPSTREAM = { rest: "https://api-testnet.qore.host", rpc: "https://rpc-testnet.qore.host" };
const ALLOWED = {
  rest: /^\/(qorechain\/(rdk|pqc|multilayer)\/v1\/|cosmos\/(tx\/v1beta1\/txs\/|bank\/v1beta1\/balances\/|upgrade\/v1beta1\/applied_plan\/|base\/tendermint\/v1beta1\/))/,
  rpc: /^\/(status|block)$/,
};

async function forward(kind, req) {
  const path = "/" + (req.params.path ?? "").replace(/^\/+/, "");
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
  app.http(`proxy-${kind}`, { methods: ["GET"], authLevel: "anonymous", route: `${kind}/{*path}`, handler: (req) => forward(kind, req) });
}
