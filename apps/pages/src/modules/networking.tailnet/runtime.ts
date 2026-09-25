/**
 * `networking.tailnet` — the Networking feature: binding this installation
 * to a Tailscale tailnet, and syncing the vault through a drive on it
 * (ADR 0144).
 *
 * The networking connector bindings (`networking` in the embedded catalogue)
 * are drawn by Settings › Capabilities under the Networking feature, and
 * only while this capability is in the plan; the connector page each tile
 * opens belongs to `connectors.external`.
 *
 * Contributed: the tailnet sync observer as a background job — it follows the
 * vault store and, for a vault paired with a drive, runs a pass on unlock,
 * shortly after each change, and once a minute — and the Tailnet sync panel
 * under Settings › Vaults, where a vault is paired.
 *
 * Egress this module wraps: `GET` and `PUT` of one sealed snapshot at
 * `{drive}/v1/vault-drive/slots/{slot}/snapshot` on the tailnet drive a
 * person paired (`lib/tailnet-sync/client.ts`) — automatic once paired, never
 * before, and never for a guest. Side effects: none at import.
 */

import type { CapabilityRuntime } from "@opensesame/app-core/lib/capabilities/runtime-contract.js";
import {
  startTailnetSync,
  stopTailnetSync,
} from "@opensesame/app-core/lib/tailnet-sync/observer.js";
import { createActivation } from "../activation.js";
import { TailnetSyncPanel } from "./TailnetSyncPanel.js";

export const CAPABILITY = "networking.tailnet";

/** Every road out of it is fenced by a sealed pairing in the open vault. */
export const TAILNET_SYNC_JOB = "tailnet-vault-sync";

export const capabilityRuntime: CapabilityRuntime = {
  capability: CAPABILITY,
  async activate(ctx) {
    const activation = createActivation(ctx, CAPABILITY);
    if (activation.disposed()) return activation.handle();

    activation.register("background-job", {
      id: TAILNET_SYNC_JOB,
      start: (signal) => {
        if (signal.aborted) return;
        startTailnetSync();
        signal.addEventListener("abort", stopTailnetSync, { once: true });
      },
    });
    activation.onDispose(stopTailnetSync);
    activation.register("settings-panel", {
      id: "tailnet-sync",
      category: "vaults",
      Panel: TailnetSyncPanel,
      order: 10,
    });

    return activation.handle();
  },
};
