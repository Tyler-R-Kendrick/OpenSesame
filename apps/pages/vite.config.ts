import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

const base = process.env.VITE_BASE ?? "/OpenSesame/";

export default defineConfig({
  base,
  build: {
    // esbuild 0.28 cannot downlevel some destructuring forms used by react-router
    // to Vite's default legacy browser set; GitHub Pages clients are modern.
    target: ["es2022", "chrome100", "firefox100", "safari15"],
  },
  // Dependency pre-bundling in dev has its own target and hits the same limitation.
  esbuild: { target: "es2022" },
  optimizeDeps: { esbuildOptions: { target: "es2022" } },
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["icon.svg"],
      manifest: {
        name: "OpenSesame",
        short_name: "OpenSesame",
        description:
          "End-to-end-encrypted vault for passwords, passkeys, and agent secrets",
        theme_color: "#101a2b",
        background_color: "#f2f5f9",
        display: "standalone",
        start_url: "./",
        scope: "./",
        icons: [
          {
            src: "icon.svg",
            sizes: "any",
            type: "image/svg+xml",
            purpose: "any maskable",
          },
        ],
      },
      workbox: {
        navigateFallback: "index.html",
        globPatterns: ["**/*.{js,css,html,svg,ico,webp,woff2}"],
      },
      devOptions: { enabled: true },
    }),
  ],
});
