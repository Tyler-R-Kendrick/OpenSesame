/**
 * `notifications.web-push` — the document half of Web Push. The worker half
 * is the separate module id `notifications.web-push/worker`, satisfied by
 * `src/sw-push.ts`; the core `worker-controller.ts` already refuses to
 * register the `push` variant until this capability is approved and
 * covered by a receipt (`VARIANT_CAPABILITY`), so the page never has to
 * register a script itself.
 *
 * The page side is one settings panel, Settings › General › Push
 * (`PushPanel`): a row and a key that turns push on for this browser or off.
 * Enrolment asks the browser for the `notifications` permission, and a module
 * may not request a permission in `activate` (ownership.md §4.3), so nothing
 * here asks until the person presses the key. The row is there only where it
 * can act: a browser that can receive push, a configured Identity API and a
 * session on it.
 *
 * Egress: the enrolment calls (`lib/push.ts`) go through `ctx.egress` with
 * this capability's declared `external-service` class — the configured
 * Identity API's push enrolment, user-initiated. Delivery after that is the
 * browser's. Side effects: none at import — in particular nothing here
 * touches `navigator.serviceWorker` or `Notification.requestPermission`. On
 * activation the module only routes `lib/push.ts`'s fetch through the egress
 * port, and puts it back on dispose.
 */

import { capabilityArtifacts } from "@opensesame/app-core/host.js";
import { WEB_PUSH_ENROLMENT_PURPOSE } from "@opensesame/app-core/lib/capabilities/catalog-optional-services.js";
import type { CapabilityRuntime } from "@opensesame/app-core/lib/capabilities/runtime-contract.js";
import { scriptUrlFor } from "@opensesame/app-core/lib/capabilities/worker/seams.js";
import { identityBase } from "@opensesame/app-core/lib/identity.js";
import { createElement } from "react";
import { pushSeams } from "../../lib/push-enrolment.js";
import { createActivation } from "../activation.js";
import { PUSH_SUBSCRIPTION_KEY, PushPanel } from "./PushPanel.js";

export const CAPABILITY = "notifications.web-push";

/**
 * The absolute URL of the push variant's script in this build, or null when
 * the build says nothing about it (a test host with no distribution). A push
 * subscription is only worth taking once the worker holding the scope is this
 * one: the core worker has no `push` handler.
 */
async function pushScriptUrl(): Promise<string | null> {
  try {
    const distribution = await capabilityArtifacts().distribution();
    const variant = distribution.workerVariants.find((v) => v.id === "push");
    return variant ? scriptUrlFor(variant.scriptPath) : null;
  } catch {
    return null;
  }
}

export const capabilityRuntime: CapabilityRuntime = {
  capability: CAPABILITY,
  async activate(ctx) {
    const activation = createActivation(ctx, CAPABILITY);
    if (activation.disposed()) return activation.handle();

    await ctx.hydrate([PUSH_SUBSCRIPTION_KEY]);
    if (activation.disposed()) return activation.handle();
    const script = await pushScriptUrl();
    if (activation.disposed()) return activation.handle();

    // The enrolment's one road out is the egress port, under this capability.
    const direct = pushSeams.fetchFn;
    const anyWorker = pushSeams.workerIsPush;
    pushSeams.fetchFn = (url, init) =>
      ctx.egress.fetch(url, init, {
        capability: CAPABILITY,
        purpose: WEB_PUSH_ENROLMENT_PURPOSE,
      });
    if (script !== null)
      pushSeams.workerIsPush = (registration) =>
        registration.active?.scriptURL === script;
    activation.onDispose(() => {
      pushSeams.fetchFn = direct;
      pushSeams.workerIsPush = anyWorker;
    });

    activation.register("settings-panel", {
      id: "push-on-this-device",
      label: "Push",
      category: "general",
      Panel: () => createElement(PushPanel, { baseUrl: identityBase }),
      order: 40,
    });

    return activation.handle();
  },
};
