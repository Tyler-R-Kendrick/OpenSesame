/**
 * Optional descriptors — the runtime-installed plugins (ADR 0150 §7,
 * `spec/plugins/catalog.json`). Advanced and default off: nothing of either
 * is in the default bundle or the default binary. The capability here is the
 * Settings section that shows a plugin a person installed at a terminal and
 * switches it on the daemon they paired; the plugin itself is never loaded
 * into the page. A drift test pins these ids to the plugin catalog
 * (`lib/plugins/catalog.test.ts`).
 */

import { type AuthoredDescriptor, optional } from "./descriptor.js";

/** The one purpose a plugin capability's requests declare (egress port). */
export const PLUGIN_DAEMON_PURPOSE =
  "the daemon a person paired over the tailnet, for one plugin's state and switch";

const DAEMON_EGRESS = {
  class: "peer-or-local-network",
  purpose: PLUGIN_DAEMON_PURPOSE,
  automatic: false,
} as const;

const OFFLINE =
  "The plugin's state is read from the paired daemon; offline it is not shown and cannot be switched.";

export const PLUGIN_FAMILY_DESCRIPTORS: readonly AuthoredDescriptor[] = [
  optional(
    "agents.surrogate-credentials",
    "Surrogate credentials",
    "Show whether the surrogate proxy plugin is installed on the paired daemon, switch it on or off there, and list its recent tripwires. The proxy is a separate binary installed at a terminal; nothing of it runs in this page.",
    {
      // The daemon is reached through the tailnet pairing (ADR 0144).
      dependencies: ["networking.tailnet"],
      operationIds: [
        "plugins.surrogate_proxy.switch",
        "plugins.surrogate_proxy.tripwires",
      ],
      egress: [DAEMON_EGRESS],
      requiresService: true,
      offlineLimits: OFFLINE,
    },
  ),
  optional(
    "vault.browser-autofill",
    "Browser autofill",
    "Show whether the paired daemon has the companion autofill extension recorded as installed, and switch it on or off there. The extension is installed separately; nothing of it runs in this page.",
    {
      dependencies: ["networking.tailnet"],
      operationIds: ["plugins.browser_autofill.switch"],
      egress: [DAEMON_EGRESS],
      requiresService: true,
      offlineLimits: OFFLINE,
    },
  ),
];
