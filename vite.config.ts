import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The Python engine writes snapshots.json to the repo root.
// We serve that directory statically during dev so the frontend
// can fetch /snapshots.json without copying.
export default defineConfig({
  plugins: [react()],
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
