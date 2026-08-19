import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    // esbuild 0.28 cannot downlevel some destructuring forms to Vite's default
    // legacy browser set (see apps/pages); ceremonies targets modern browsers.
    target: ["es2022", "chrome100", "firefox100", "safari15"],
  },
  // Dependency pre-bundling in dev has its own target and hits the same limitation.
  esbuild: { target: "es2022" },
  optimizeDeps: { esbuildOptions: { target: "es2022" } },
  plugins: [react()],
  server: {
    port: 5181,
    strictPort: true,
  },
});
