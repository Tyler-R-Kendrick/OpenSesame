/**
 * Storybook's own Vite config: the app's resolution (the os-domain aliases,
 * the two `define`s, the pre-bundled wasm deps) without its build plugins.
 * The PWA plugin, capability composition and the security-profile stamp are
 * for `vite build` of the shipped app; a story renders one component on the
 * app's stylesheet and needs none of them.
 */
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const osDomain = (path: string) =>
  fileURLToPath(
    new URL(`../../../packages/os-domain/src/${path}`, import.meta.url),
  );

export default defineConfig({
  define: {
    "process.env.NODE_DEBUG_NATIVE": "false",
    __NATIVE_GOOGLE_HEADER_SECURITY__: "false",
  },
  resolve: {
    alias: {
      "@opensesame/os-domain/authority-templates": osDomain(
        "authority-templates/index.ts",
      ),
      "@opensesame/os-domain/wallet": osDomain("wallet/index.ts"),
      "@opensesame/os-domain": osDomain("browser.ts"),
    },
  },
  optimizeDeps: {
    exclude: ["@opensesame/os-domain"],
    include: [
      "@opensesame/app-core > kdbxweb",
      "@opensesame/app-core > hash-wasm",
      "@opensesame/app-core > @noble/ciphers/aes",
    ],
    esbuildOptions: { target: "es2022" },
  },
  esbuild: { target: "es2022" },
  // The app's own targets: esbuild cannot downlevel the destructuring
  // react-router and app-core use to Vite's default legacy set.
  build: { target: ["es2022", "chrome100", "firefox100", "safari15"] },
  worker: { format: "es" },
  plugins: [react()],
});
