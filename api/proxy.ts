/**
 * A narrow proxy to QoreChain testnet for the website (Vercel edge
 * function; the testnet API sends no CORS headers). vercel.json rewrites
 * /api/rest/<path> and /api/rpc/<path> here as ?kind=&path=. GET only the
 * paths the page reads; POST only to simulate or broadcast a transaction the
 * visitor's browser already signed (the claim form), with a size cap. It holds
 * no keys, so it can only relay what a wallet signed itself.
 */
export const config = { runtime: "edge" };

const UPSTREAM: Record<string, string> = {
  rest: "https://api-testnet.qore.host",
  rpc: "https://rpc-testnet.qore.host",
};
const ALLOWED: Record<string, RegExp> = {
  rest: /^\/(qorechain\/(rdk|pqc|multilayer)\/v1\/|cosmos\/(tx\/v1beta1\/txs\/|auth\/v1beta1\/accounts\/|bank\/v1beta1\/balances\/|upgrade\/v1beta1\/applied_plan\/|base\/tendermint\/v1beta1\/))/,
  rpc: /^\/(status|block)$/,
};
const POST_ALLOWED = /^\/cosmos\/tx\/v1beta1\/(simulate|txs)$/;
const MAX_BODY = 64 * 1024;

export default async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const kind = url.searchParams.get("kind") ?? "";
  const path = "/" + (url.searchParams.get("path") ?? "").replace(/^\/+/, "");
  if (req.method === "POST") {
    if (kind !== "rest" || !POST_ALLOWED.test(path)) return new Response("not found", { status: 404 });
    const body = await req.text();
    if (body.length > MAX_BODY) return new Response("too large", { status: 413 });
    const upstream = await fetch(UPSTREAM.rest + path, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body });
    return new Response(upstream.body, { status: upstream.status, headers: { "content-type": upstream.headers.get("content-type") ?? "application/json", "cache-control": "no-store" } });
  }
  if (req.method !== "GET") return new Response("method not allowed", { status: 405 });
  if (!UPSTREAM[kind] || !ALLOWED[kind].test(path) || path.includes("..")) return new Response("not found", { status: 404 });
  url.searchParams.delete("kind");
  url.searchParams.delete("path");
  const qs = url.searchParams.toString();
  const upstream = await fetch(UPSTREAM[kind] + path + (qs ? `?${qs}` : ""), { headers: { accept: "application/json" } });
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { "content-type": upstream.headers.get("content-type") ?? "application/json", "cache-control": "public, max-age=5" },
  });
}
