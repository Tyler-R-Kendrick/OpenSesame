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
import type { Provider } from "@opensesame/app-core/lib/connections.js";
import {
  type FeatureOperation,
  runListedFeature,
} from "@opensesame/app-core/lib/feature-connector-operation.js";
import type { FeatureRequest } from "@opensesame/app-core/lib/feature-request.js";
import {
  startTailnetSync,
  stopTailnetSync,
} from "@opensesame/app-core/lib/tailnet-sync/observer.js";
import {
  bindTailnetConnector,
  registerTailnetReader,
  tailnetSyncHeaders,
} from "@opensesame/app-core/lib/tailnet-sync/saved-connector.js";
import { createActivation } from "../activation.js";
import { TailnetSyncPanel } from "./TailnetSyncPanel.js";

export const CAPABILITY = "networking.tailnet";

/** Every road out of it is fenced by a sealed pairing in the open vault. */
export const TAILNET_SYNC_JOB = "tailnet-vault-sync";

/** The tailnet feature's catalog operation, from the configuration saved on this device. */
export function savedTailnetOperation(
  provider: Provider | string = "tailscale",
): FeatureOperation {
  return runListedFeature(provider);
}

function tailnetHeadersMatch(
  operation: FeatureOperation & { ok: true },
): boolean {
  const headers = tailnetSyncHeaders();
  if (
    operation.secrets.auth_key &&
    headers["x-tailscale-auth-key"] !== operation.secrets.auth_key
  ) {
    return false;
  }
  for (const [name, value] of Object.entries(operation.action)) {
    if (headers[`x-tailnet-${name.replaceAll("_", "-")}`] !== value) {
      return false;
    }
  }
  return true;
}

/**
 * Bind one saved Tailscale operation onto the sync request.
 * Nothing saved does not succeed.
 */
export function applySavedTailnet(operation: FeatureOperation): FeatureRequest {
  if (!operation.ok) {
    bindTailnetConnector(null);
    return { ok: false, providerId: operation.providerId };
  }
  bindTailnetConnector({
    providerId: operation.providerId,
    operation: operation.operation,
    fields: { ...operation.action },
    secret: { ...operation.secrets },
  });
  if (!tailnetHeadersMatch(operation)) {
    return { ok: false, providerId: operation.providerId };
  }
  return {
    ok: true,
    providerId: operation.providerId,
    operation: operation.operation,
    fields: { ...operation.action },
    secret: { ...operation.secrets },
  };
}

/** Bind the saved Tailscale fields and auth key onto the sync request. */
export function performTailnetSync(
  provider: Provider | string = "tailscale",
): FeatureRequest {
  return applySavedTailnet(savedTailnetOperation(provider));
}

/** Re-read the saved Tailscale record for this drive request. */
export function readSavedTailnet(): FeatureOperation {
  const operation = savedTailnetOperation();
  applySavedTailnet(operation);
  return operation;
}

export const capabilityRuntime: CapabilityRuntime = {
  capability: CAPABILITY,
  async activate(ctx) {
    const activation = createActivation(ctx, CAPABILITY);
    if (activation.disposed()) return activation.handle();
    activation.onDispose(registerTailnetReader(readSavedTailnet));

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
      label: "Tailnet sync",
      category: "vaults",
      Panel: TailnetSyncPanel,
      order: 10,
    });

    return activation.handle();
  },
};
