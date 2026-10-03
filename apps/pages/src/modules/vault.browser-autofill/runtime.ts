/**
 * `vault.browser-autofill` — the Browser autofill section of Settings ›
 * Capabilities (ADR 0150 §7). Optional, default off, and never always-on:
 * nothing of it reaches the page before the plan approved it and a consent
 * receipt covered its exposure (ADR 0130).
 *
 * The autofill extension itself is a separate browser extension
 * (`@opensesame/browser-extension-autofill`) a person installs on purpose;
 * it fills a login field from its own UI, by reference. It is in no default
 * build and never in this bundle — this page does no filling and no network
 * substitution. This module only shows what the paired daemon records about
 * the extension and switches it there.
 *
 * Contributed: the plugin's tile inside its section, its file
 * (`settings/capabilities/plugins/browser-autofill.json`, read-only) and its
 * walkthrough (`tutorial/registry/plugins-catalog.ts`).
 *
 * Egress this module makes, all through `ctx.egress` to the daemon a person
 * paired this page with (`opensesame plugins pair`, reached on this machine or
 * over the tailnet — `networking.tailnet`, a dependency), and only once the
 * tile is drawn with a pairing in the open vault: `GET /v1/plugins`, and
 * on the switch `PUT /v1/plugins/browser-autofill`. Pairing, when a
 * person pastes the code `opensesame plugins pair` printed: one
 * `POST /v1/plugins/pairing` to the daemon the code names; forgetting it:
 * one `DELETE /v1/plugins/pairing`. With no daemon paired it
 * sends nothing. Side effects: none at import, none on activation.
 */

import type { CapabilityRuntime } from "@opensesame/app-core/lib/capabilities/runtime-contract.js";
import { pluginById } from "@opensesame/app-core/lib/plugins/catalog.js";
import { tailnetPluginDaemon } from "@opensesame/app-core/lib/tailnet-sync/plugin-daemon.js";
import {
  AUTOFILL_GOALS,
  AUTOFILL_TARGETS,
} from "@opensesame/app-core/tutorial/registry/plugins-catalog.js";
import { createActivation } from "../activation.js";
import { contributePlugin } from "../plugin-activation.js";

export const CAPABILITY = "vault.browser-autofill";

export const capabilityRuntime: CapabilityRuntime = {
  capability: CAPABILITY,
  async activate(ctx) {
    const activation = createActivation(ctx, CAPABILITY);
    if (activation.disposed()) return activation.handle();

    contributePlugin(activation, {
      plugin: pluginById("browser-autofill"),
      daemon: tailnetPluginDaemon(ctx.egress, CAPABILITY),
      section: "feature-autofill",
      guideId: "settings.browser-autofill",
      tutorial: { targets: AUTOFILL_TARGETS, goals: AUTOFILL_GOALS },
    });

    return activation.handle();
  },
};
