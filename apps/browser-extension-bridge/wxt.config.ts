import { defineConfig } from "wxt";

/**
 * The bridge's manifest (ADR 0199). What it does not declare is the point:
 *
 * - no `content_scripts`: the relay is registered at runtime, for the one
 *   origin a person switched the bridge on for, top frame only;
 * - no `host_permissions`: every host the bridge may reach is an
 *   `optional_host_permissions` entry the popup asks the browser for, one host
 *   at a time, on the person's own click.
 *
 */
export default defineConfig({
  vite: () => ({
    // MV3 runs on Chromium and Firefox only; see apps/browser-extension.
    build: { target: ["chrome111", "firefox115"] },
  }),
  zip: { artifactTemplate: "connector-bridge-{{version}}-{{browser}}.zip" },
  manifest: {
    name: "OpenSesame connector bridge",
    description:
      "Optional OpenSesame companion: lets the app reach providers whose servers refuse web pages, only at hosts you allow",
    // declarativeNetRequestWithHostAccess only ever acts on hosts a person
    // granted: it takes the Origin header off the bridge's own requests.
    permissions: [
      "storage",
      "scripting",
      "activeTab",
      "declarativeNetRequestWithHostAccess",
    ],
    optional_host_permissions: ["https://*/*", "http://*/*"],
    content_security_policy: {
      extension_pages: "script-src 'self'; object-src 'none'",
    },
  },
});
