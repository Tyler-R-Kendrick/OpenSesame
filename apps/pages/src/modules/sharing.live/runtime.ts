/**
 * `sharing.live` — live sessions, browser to browser (ADR 0148).
 *
 * Contributed: the `/live` join screen (`gate: "any"`, framed — it holds no
 * vault key, so it opens on a locked or empty device, and inside the shell
 * in an unlocked tab), and the Live session panel under Settings › Vaults,
 * where the owner hosts one from this tab.
 *
 * The sessions themselves live in `app-core/lib/live/session.ts`, not here:
 * this module is disposed and activated again on every lock, unlock and
 * consent commit, and a joiner must not be dropped because the page
 * re-planned.
 *
 * Egress this module wraps, none of it at activation and all of it started
 * by the person: a WebRTC peer connection to the other browser, directly,
 * with no ICE server — no relay, STUN or TURN — once the two people have
 * passed each other the sealed pairing codes (`lib/live/pairing.ts`,
 * `lib/live/peer.ts`); the clipboard on a copy. Side effects: none at
 * import.
 */

import type { CapabilityRuntime } from "@opensesame/app-core/lib/capabilities/runtime-contract.js";
import { createActivation } from "../activation.js";
import { LiveHostPanel } from "./LiveHostPanel.js";
import { LiveJoinRoute } from "./LiveJoinRoute.js";

export const CAPABILITY = "sharing.live";

export const capabilityRuntime: CapabilityRuntime = {
  capability: CAPABILITY,
  async activate(ctx) {
    const activation = createActivation(ctx, CAPABILITY);
    if (activation.disposed()) return activation.handle();

    activation.register("route", {
      id: "live",
      path: "/live",
      element: LiveJoinRoute,
      framed: true,
      order: 48,
      gate: "any",
    });
    activation.register("settings-panel", {
      id: "live-session",
      label: "Live session",
      category: "vaults",
      Panel: LiveHostPanel,
      order: 20,
    });

    return activation.handle();
  },
};
