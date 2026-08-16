import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

// Tauri drives this dev server; the port is fixed because tauri.conf.json
// points at it and a moving port would break `tauri dev`.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // The connection, invite, and deep-link logic is shared with the web
      // app rather than reimplemented here — one tested implementation of
      // "which servers am I connected to", not two that drift.
      "@shared": resolve(__dirname, "../shared"),
      "@": resolve(__dirname, "src"),
    },
  },
  server: {
    port: 5174,
    strictPort: true,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // Tauri ships a known WebView version per platform, so there's no reason
    // to transpile down for browsers nobody will use this in.
    target: "es2022",
    sourcemap: true,
  },
});
