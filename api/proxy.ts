/**
 * A read-only proxy to QoreChain testnet for the website (Vercel edge
 * function; the testnet API sends no CORS headers). vercel.json rewrites
 * /api/rest/<path> and /api/rpc/<path> here as ?kind=&path=. Only GET, only
 * the paths the page reads, so it cannot broadcast or act as an open proxy.
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
  const kind = url.searchParams.get("kind") ?? "";
  const path = "/" + (url.searchParams.get("path") ?? "").replace(/^\/+/, "");
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
