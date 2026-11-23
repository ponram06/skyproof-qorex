/**
 * A read-only proxy to QoreChain testnet for the website (Vercel edge
 * function). Only GET, only the paths the page reads, so it cannot be used
 * to broadcast anything or as an open proxy.
 */
export const config = { runtime: "edge" };

const UPSTREAM: Record<string, string> = {
  rest: "https://api-testnet.qore.host",
  rpc: "https://rpc-testnet.qore.host",
};
const ALLOWED: Record<string, RegExp> = {
  rest: /^\/(qorechain\/(rdk|pqc|multilayer)\/v1\/|cosmos\/(tx\/v1beta1\/txs\/|bank\/v1beta1\/balances\/|upgrade\/v1beta1\/applied_plan\/|base\/tendermint\/v1beta1\/))/,
  rpc: /^\/(status|block)$/,
};

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== "GET") return new Response("method not allowed", { status: 405 });
  const url = new URL(req.url);
  const m = url.pathname.match(/^\/api\/(rest|rpc)(\/.*)$/);
  if (!m || !ALLOWED[m[1]].test(m[2])) return new Response("not found", { status: 404 });
  const upstream = await fetch(UPSTREAM[m[1]] + m[2] + url.search, { headers: { accept: "application/json" } });
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { "content-type": upstream.headers.get("content-type") ?? "application/json", "cache-control": "public, max-age=5" },
  });
}
