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
    // The local runner (ADR 0076/0079/0082): nothing here is held until a
    // person asks the browser for one origin on the options page, and each
    // grant is given back when its run ends or its arm expires. No content
    // script is declared; page functions are injected on demand.
    optional_permissions: ["scripting"],
    optional_host_permissions: ["https://*/*"],
    content_security_policy: {
      extension_pages: "script-src 'self'; object-src 'self'",
    },
  },
});
