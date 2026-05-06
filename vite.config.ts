import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Minimal type shim so TypeScript recognises process.env without requiring
// @types/node in tsconfig.node.json.
declare const process: { env: Record<string, string | undefined> };

// VITE_BASE_PATH is set by the GitHub Actions deploy workflow so that
// asset paths resolve correctly when hosted at /repo-name/ on GitHub Pages.
// During local dev the variable is unset and the app runs at /.
export default defineConfig({
  plugins: [react()],
  base: process.env.VITE_BASE_PATH ?? "/",
  publicDir: "public",
  server: {
    port: 5173,
    strictPort: false,
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
