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
  build: { target: "es2022" },
});
