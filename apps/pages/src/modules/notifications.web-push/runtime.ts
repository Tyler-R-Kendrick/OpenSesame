/**
 * `notifications.web-push` — the document half of Web Push. The worker half
 * is the separate module id `notifications.web-push/worker`, satisfied by
 * `src/sw-push.ts`; the core `worker-controller.ts` already refuses to
 * register the `push` variant until this capability is approved and
 * covered by a receipt (`VARIANT_CAPABILITY`), so the page never has to
 * register a script itself.
 *
 * The page side registers no contribution today: `lib/push.ts`
 * (`pushSupported`, `enablePush`, `disablePush`, `fetchApplicationServerKey`)
 * has no caller in `apps/pages/src` — there is no enrolment row in Settings
 * yet. That is deliberate rather than an omission to paper over: enrolment
 * asks the browser for the `notifications` permission, and a module may not
 * request a permission in `activate` (ownership.md §4.3). It has to be the
 * person pressing a control.
 *
 * When that control lands it goes here — a settings panel or an
 * `unlock-effect` that only *reads* an existing enrolment — and the
 * enrolment call keeps going through `ctx.egress` with this capability's
 * declared `external-service` class (the configured Identity API's push
 * enrolment, user-initiated). Delivery after that is the browser's.
 *
 * Egress: none from this module today. Side effects: none at import — in
 * particular nothing here touches `navigator.serviceWorker` or
 * `Notification.requestPermission`.
 */

import type { CapabilityRuntime } from "../../lib/capabilities/runtime-contract.js";
import { createActivation } from "../activation.js";

export const CAPABILITY = "notifications.web-push";

export const capabilityRuntime: CapabilityRuntime = {
  capability: CAPABILITY,
  async activate(ctx) {
    return createActivation(ctx, CAPABILITY).handle();
  },
};
