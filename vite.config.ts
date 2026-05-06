import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

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
