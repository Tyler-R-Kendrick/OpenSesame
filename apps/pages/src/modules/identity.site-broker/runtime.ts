/**
 * `identity.site-broker` — broker a brokered identity to approved relying
 * sites over postMessage (ADR 0034): the `/broker/authorize` popup, the
 * per-site consents and domain policy (`lib/site-broker.ts`), and the
 * `@opensesame/static-auth` SDK files this origin serves (`public/auth.js`,
 * `public/static-auth/**`, owned in `lib/capabilities/ownership.ts`).
 *
 * The popup is `gate: "any"` and unframed, exactly as `App.tsx` served it:
 * it opens on a locked device, holds no vault key, and answers only the
 * opener whose exact origin the person approved. The origin check, the
 * `postMessage` target and the opener policy are unchanged — this module
 * wraps the screen, it does not re-decide who may be answered.
 *
 * Egress: `user-mediated-navigation` only — the `postMessage` delivery to
 * the relying site's approved origin, after the person presses Allow. No
 * fetch of ours leaves the page.
 *
 * Side effects: none at import.
 */

import type { CapabilityRuntime } from "../../lib/capabilities/runtime-contract.js";
import { BrokerAuthorize } from "../../screens/BrokerAuthorize.js";
import { createActivation } from "../activation.js";

export const CAPABILITY = "identity.site-broker";

export const capabilityRuntime: CapabilityRuntime = {
  capability: CAPABILITY,
  async activate(ctx) {
    const activation = createActivation(ctx, CAPABILITY);
    if (activation.disposed()) return activation.handle();

    activation.register("route", {
      id: "broker-authorize",
      path: "/broker/authorize",
      element: BrokerAuthorize,
      framed: false,
      order: 70,
      gate: "any",
    });

    return activation.handle();
  },
};
