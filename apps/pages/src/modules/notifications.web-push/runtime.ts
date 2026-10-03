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

import type { CapabilityRuntime } from "@opensesame/app-core/lib/capabilities/runtime-contract.js";
import { identityBase } from "@opensesame/app-core/lib/identity.js";
import { createElement } from "react";
import { pushSeams } from "../../lib/push.js";
import { createActivation } from "../activation.js";
import { PUSH_SUBSCRIPTION_KEY, PushPanel } from "./PushPanel.js";

export const CAPABILITY = "notifications.web-push";

export const capabilityRuntime: CapabilityRuntime = {
  capability: CAPABILITY,
  async activate(ctx) {
    const activation = createActivation(ctx, CAPABILITY);
    if (activation.disposed()) return activation.handle();

    await ctx.hydrate([PUSH_SUBSCRIPTION_KEY]);
    if (activation.disposed()) return activation.handle();

    // The enrolment's one road out is the egress port, under this capability.
    const direct = pushSeams.fetchFn;
    pushSeams.fetchFn = (url, init) =>
      ctx.egress.fetch(url, init, {
        capability: CAPABILITY,
        purpose: "push enrolment with the configured Identity API",
      });
    activation.onDispose(() => {
      pushSeams.fetchFn = direct;
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
