import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  build: {
    // esbuild 0.28 cannot downlevel some destructuring forms to Vite's default
    // legacy browser set (see apps/pages); this demo targets modern browsers.
    target: ["es2022", "chrome100", "firefox100", "safari15"],
  },
  plugins: [react()],
  server: { port: 5175, strictPort: true },
});
