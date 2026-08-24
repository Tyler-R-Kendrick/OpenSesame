import { defineConfig } from "wxt";

export default defineConfig({
  // Vite's default web target ("modules") includes safari14, and esbuild treats
  // destructuring as unsupported there (a real Safari 14 bug) then fails rather
  // than lowering it — which breaks any dependency shipping plain destructuring.
  // An MV3 extension only ever runs on Chromium/Firefox, so target those.
  vite: () => ({
    build: { target: ["chrome111", "firefox115"] },
  }),
  manifest: {
    name: "OpenSesame",
    description:
      "Private authorization fabric — Host API health and sealed sync, never raw secrets",
    permissions: ["storage", "alarms"],
    host_permissions: ["http://127.0.0.1/*", "http://localhost/*"],
    content_security_policy: {
      extension_pages: "script-src 'self'; object-src 'self'",
    },
  },
});
