/**
 * `sharing.live` — live sessions, browser to browser (ADR 0150).
 *
 * Contributed: the `/live` join screen (`gate: "any"`, framed — it holds no
 * vault key, so it opens on a locked or empty device, and inside the shell
 * in an unlocked tab), and the Settings › Live sessions tab: the panel where
 * the owner hosts one from this tab, and its routes, whose file is
 * `settings/live/transport.json` (sealed in the vault, ADR 0134).
 *
 * The sessions themselves live in `app-core/lib/live/session.ts`, not here:
 * this module is disposed and activated again on every lock, unlock and
 * consent commit, and a joiner must not be dropped because the page
 * re-planned.
 *
 * Egress this module wraps, none of it at activation and all of it started
 * by the person: a WebRTC peer connection to the other browser once the
 * sealed pairing codes have crossed (`lib/live/pairing.ts`,
 * `lib/live/peer.ts`) — directly by default, with no ICE server; the
 * clipboard on a copy under Show values or Can edit. Copy only does not
 * place a concealed value on the joiner's clipboard. Only what the owner
 * names in Routes adds more, and only for the owner's sessions and joiners
 * who agree to the hosts the link lists: the STUN and TURN servers named,
 * and the carriers named
 * (`carriers/`: a Nostr relay, an MQTT broker or NATS server over wss, an
 * ntfy server over https, or BroadcastChannel), each client loaded only then
 * and only if the installation allows it: ntfy fetches through this module's
 * `EgressPort`, and the socket carriers are held to the same plan and
 * allowlist (`carriers/allowed.ts`). A session ends if the plan stops
 * approving this capability (`lib/live/session.ts`).
 * Side effects: none at import.
 */

import type { CapabilityRuntime } from "@opensesame/app-core/lib/capabilities/runtime-contract.js";
import { compositionStore } from "@opensesame/app-core/lib/capabilities/store.js";
import { liveTransportFiles } from "@opensesame/app-core/sections/settings/live-transport-files.js";
import {
  LIVE_GOALS,
  LIVE_ROUTES,
  LIVE_TARGETS,
} from "@opensesame/app-core/tutorial/registry/live-catalog.js";
import { liveSeams } from "@opensesame/app-core/lib/live/session.js";
import { createActivation } from "../activation.js";
import {
  clearLiveHostAskingNotices,
  noteGuestAsking,
} from "./live-host-tray.js";
import { registerTutorial } from "../tutorial-contributions.js";
import { LiveJoinRoute } from "./LiveJoinRoute.js";
import { LiveSettings } from "./LiveSettings.js";
import { carrierFactory, carriersUnavailable } from "./carriers/index.js";
import { liveUiSeams } from "./live-hooks.js";
import { transportSeams } from "./live-transport-hooks.js";

export const CAPABILITY = "sharing.live";

export const capabilityRuntime: CapabilityRuntime = {
  capability: CAPABILITY,
  async activate(ctx) {
    const activation = createActivation(ctx, CAPABILITY);
    if (activation.disposed()) return activation.handle();

    // Carriers open through this activation's egress port and the current
    // plan, so a session started here is held to what the installation allows
    // (ADR 0150 §7); a later activation replaces it, and dispose takes it away.
    const carriers = carrierFactory({
      egress: ctx.egress,
      plan: () => compositionStore.getSnapshot().plan,
    });
    liveUiSeams.carriers = carriers;
    const priorHostState = liveSeams.onHostState;
    const priorHostingEnded = liveSeams.onHostingEnded;
    liveSeams.onHostState = noteGuestAsking;
    liveSeams.onHostingEnded = clearLiveHostAskingNotices;
    activation.onDispose(() => {
      if (liveUiSeams.carriers === carriers)
        liveUiSeams.carriers = carriersUnavailable;
      liveSeams.onHostState = priorHostState;
      liveSeams.onHostingEnded = priorHostingEnded;
    });

    activation.register("route", {
      id: "live",
      path: "/live",
      element: LiveJoinRoute,
      framed: true,
      order: 48,
      gate: "any",
    });
    activation.register("settings-category", {
      id: "live",
      label: "Live sessions",
      guideId: "settings.live",
      Panel: LiveSettings,
      panels: [
        { id: "live-session", label: "Live session" },
        { id: "live-routes", label: "Routes" },
      ],
      order: 320,
      files: liveTransportFiles(() => transportSeams.tomb()),
    });
    registerTutorial(activation, {
      targets: LIVE_TARGETS,
      goals: LIVE_GOALS,
      routes: LIVE_ROUTES,
    });

    return activation.handle();
  },
};
