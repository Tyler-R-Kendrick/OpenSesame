/**
 * What an unlock picks back up for external connectors (moved here from
 * `App.tsx`'s `useAfterUnlock`): a connector directory synced during setup
 * that waited for a vault to seal it (ADR 0115), and a staged or sealed
 * Vercel Connect bearer that arms the live transport. Both are no-ops with
 * nothing outstanding, and both stop the moment the lease or the effect's
 * own signal aborts — a capability disabled mid-flight seals nothing more.
 */

import type { UnlockEffectContribution } from "../../lib/capabilities/runtime-contract.js";
import { sealPendingConnectorDirectory } from "../../lib/connector-directory.js";
import { hydrateVercelConnectAuth } from "../../lib/vercel-connect-session.js";
import { anySignal, runUnlessAborted } from "../signals.js";

/** Test seam: the two sealing calls, swappable without a module mock. */
export const connectorUnlockSeams = {
  sealPendingConnectorDirectory,
  hydrateVercelConnectAuth,
};

export function connectorUnlockEffects(
  lease: AbortSignal,
): UnlockEffectContribution[] {
  return [
    {
      id: "seal-connector-directory",
      run: ({ tomb, guest, signal }) =>
        runUnlessAborted(anySignal([lease, signal]), async () => {
          // A guest tomb is wiped on lock, so it gets the list without
          // taking it: the sync still waits for the vault that lasts.
          await connectorUnlockSeams
            .sealPendingConnectorDirectory(tomb, { ephemeral: guest })
            .catch(() => {
              // The endpoint is on record; Access › Connectors syncs again.
            });
        }),
    },
    {
      id: "hydrate-vercel-connect",
      run: ({ tomb, guest, signal }) =>
        runUnlessAborted(anySignal([lease, signal]), async () => {
          // A sealed token arms the live transport, and a staged one lands
          // with the first open tomb.
          await connectorUnlockSeams
            .hydrateVercelConnectAuth(tomb, { ephemeral: guest })
            .catch(() => {
              // A corrupt record reads as no Connect session, not a trapped
              // vault.
            });
        }),
    },
  ];
}
