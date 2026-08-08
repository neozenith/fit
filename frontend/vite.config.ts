import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * The dev server proxies `/api` to the local API rather than having the SPA
 * call it cross-origin. That keeps the browser's view of the world identical
 * to production, where CloudFront serves both from one hostname — so a cookie
 * that works locally works deployed, and there is no CORS configuration that
 * exists only in development (ADR-0016).
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: process.env["VITE_API_ORIGIN"] ?? "http://localhost:8787",
        changeOrigin: false,
      },
    },
  },
  resolve: {
    alias: {
      "@fit/program": new URL("../packages/program/src/index.ts", import.meta.url).pathname,
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
