import { defineConfig } from "wxt";
import { DAEMON_PATTERN } from "./lib/sites/patterns";

/**
 * The companion's manifest (ADR 0150 §6.4, §7). What it does not declare is
 * the point:
 *
 * - no `content_scripts`: the guard runs on no page until a person switches
 *   a site on in the popup, and then only on that site, registered at
 *   runtime with `scripting.registerContentScripts`;
 * - no `host_permissions`: every host, the daemon's loopback included, is an
 *   `optional_host_permissions` entry the popup requests for one exact site
 *   on the person's own click, and gives back when they switch it off.
 *
 * `activeTab` lets the popup and the keyboard command read the tab a person
 * is looking at; it grants nothing on its own.
 */
export default defineConfig({
  vite: () => ({
    // MV3 runs on Chromium and Firefox only; see apps/browser-extension.
    build: { target: ["chrome111", "firefox115"] },
  }),
  // The artifact `opensesame plugins install browser-autofill --from` pins.
  zip: { artifactTemplate: "browser-autofill-{{version}}-{{browser}}.zip" },
  manifest: {
    name: "OpenSesame autofill",
    description:
      "Optional OpenSesame plugin: fill a focused login field by reference, on sites you switch on, after your own gesture",
    permissions: ["storage", "scripting", "activeTab"],
    optional_host_permissions: ["https://*/*", "http://*/*", DAEMON_PATTERN],
    commands: {
      "fill-focused-field": {
        suggested_key: { default: "Alt+Shift+O" },
        description: "Fill the focused login field on this page",
      },
    },
    content_security_policy: {
      extension_pages: "script-src 'self'; object-src 'self'",
    },
  },
});
