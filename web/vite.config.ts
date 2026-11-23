import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// In development, Vite forwards /api/* to QoreChain testnet (the testnet API
// sends no CORS headers, so a browser cannot call it directly). In production
// the same paths are served by the functions in api/.
export default defineConfig({
  server: {
    // The investigator view imports the rules from ../rollup, so the browser judges with the same code.
    fs: { allow: [".."] },
    proxy: {
      "/api/rest": { target: "https://api-testnet.qore.host", changeOrigin: true, rewrite: (p) => p.replace(/^\/api\/rest/, "") },
      "/api/rpc": { target: "https://rpc-testnet.qore.host", changeOrigin: true, rewrite: (p) => p.replace(/^\/api\/rpc/, "") },
    },
  },
  // Shared code in ../rollup imports "@noble/hashes/sha2"; resolve that one import from this
  // package, so the site also builds where ../rollup has no node_modules (e.g. on Vercel).
  resolve: { alias: [{ find: /^@noble\/hashes\/sha2$/, replacement: fileURLToPath(new URL("./node_modules/@noble/hashes/sha2.js", import.meta.url)) }] },
  build: { target: "es2022" },
});
