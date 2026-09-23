import type {
  Connection,
  Provider,
} from "@opensesame/app-core/lib/connections.js";
import {
  buildConnectorReminder,
  hasConnectorReminder,
} from "@opensesame/app-core/lib/identity-graph.js";
import {
  type Flash,
  errorText,
} from "@opensesame/app-core/sections/connections/shared.js";
import { useState } from "react";
import { IconCheck } from "../../components/Icons.js";
import { useVault, useVaultStore } from "../../lib/vault/hooks.js";

/** After a connect, offer to drop a pointer (never the token) into the vault. */
export function VaultReminderBanner({
  offer,
  onFlash,
  onDismiss,
}: {
  offer: { provider: Provider; connection: Connection };
  onFlash: (flash: Flash | null) => void;
  onDismiss: () => void;
}) {
  const { items } = useVault();
  const store = useVaultStore();
  const [busy, setBusy] = useState(false);
  if (hasConnectorReminder(items, offer.connection)) return null;

  async function save() {
    setBusy(true);
    try {
      await store.addItems([
        buildConnectorReminder(offer.provider, offer.connection),
      ]);
      onFlash({
        tone: "ok",
        text: `Connection saved. Added a vault reminder for ${offer.provider.displayName}. The credential itself is not stored in the vault.`,
      });
      onDismiss();
    } catch (error) {
      onFlash({ tone: "err", text: errorText(error) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <output className="note note--ok conn-flash">
      <IconCheck />
      <p>
        Saved {offer.provider.displayName}. Add a vault reminder that points at
        the ConnectionRef — not the token?
      </p>
      <button
        type="button"
        className="btn btn--sm btn--primary"
        disabled={busy}
        onClick={() => void save()}
      >
        Remember in vault
      </button>
      <button type="button" className="btn btn--sm" onClick={onDismiss}>
        Not now
      </button>
    </output>
  );
}
