import { selectProtectionView } from "@opensesame/app-core/lib/vault/protection/protection-view.js";
import type { VaultKeyProtectionActions } from "@opensesame/app-core/sections/settings/vault-key-protection-panel-model.js";
import { useEffect, useMemo, useState } from "react";
import { IconAlert, IconPlus } from "../../components/Icons.js";
import { useVault, useVaultStore } from "../../lib/vault/hooks.js";
import { useGuideTarget } from "../../tutorial/registry/react.jsx";
import {
  type ProtectionSheetRequest,
  VaultKeyProtectionSheet,
} from "./VaultKeyProtectionCeremonies.js";
import { ProtectorRow } from "./VaultProtectorRow.js";
import { useVaultKeyProtectionActions } from "./useVaultKeyProtectionActions.js";

/**
 * Settings › Security › Vault key protection — the protectors enrolled on an
 * open vault, each with the three things a person can do to it (test, prefer,
 * remove), and the two ways to change the set (add, rotate).
 *
 * Every key here works or the panel is not drawn: a guest, or a vault that is
 * still locked, has no protectors to act on, so there is nothing to disable
 * and no reason to explain. Enrolling a key under Unlock methods is what
 * brings the panel in.
 */
export function VaultKeyProtectionPanel({
  actions: actionsProp,
}: {
  actions?: VaultKeyProtectionActions;
} = {}) {
  const { header, guest } = useVault();
  const store = useVaultStore();
  const [sheet, setSheet] = useState<ProtectionSheetRequest | null>(null);
  const panelRef = useGuideTarget<HTMLElement>("settings.vault-key-protection");
  const view = useMemo(
    () => selectProtectionView({ header: guest ? null : header }),
    [guest, header],
  );
  const defaultActions = useVaultKeyProtectionActions({
    openSheet: setSheet,
    methodKind: (id) =>
      view.methods.find((row) => row.protectorId === id)?.kind,
  });
  const actions = actionsProp ?? defaultActions;
  // A vault sealed on this device carries no manifest until something writes
  // one, and Unlock methods changes the header's wraps without touching it.
  // Rows drawn from a stale manifest name protectors that are gone or miss ones
  // that were added, so the manifest is brought in step whenever the header
  // changes — a no-op when they already agree.
  const canAct = actions !== undefined;
  useEffect(() => {
    if (!canAct || !header) return;
    void store.protection.ensureProtectionProjected().catch(() => undefined);
  }, [canAct, header, store]);
  if (!actions) return null;

  return (
    <>
      <section
        className="panel set__security"
        id="vault-key-protection"
        ref={panelRef}
        aria-labelledby="vault-key-protection-title"
      >
        <div className="panel__head">
          <div>
            <h2 id="vault-key-protection-title">Vault key protection</h2>
          </div>
          <div className="actions">
            <button
              type="button"
              className="icon-btn icon-btn--sm"
              aria-label="Add key protection method"
              title="Add key protection method"
              onClick={actions.onAdd}
            >
              <IconPlus size={16} />
            </button>
            <button
              type="button"
              className="icon-btn icon-btn--sm"
              aria-label="Rotate compromised vault key"
              title="Rotate compromised vault key"
              onClick={actions.onRotateCompromised}
            >
              <IconAlert size={16} />
            </button>
          </div>
        </div>
        <div className="panel__body">
          {view.methods.map((row) => (
            <ProtectorRow
              key={row.protectorId}
              row={row}
              preferred={view.preferredProtectorId === row.protectorId}
              onTest={actions.onTest}
              onPreferred={actions.onPreferred}
              onRemove={actions.onRemove}
            />
          ))}
        </div>
      </section>
      {sheet ? (
        <VaultKeyProtectionSheet
          request={sheet}
          onClose={() => setSheet(null)}
        />
      ) : null}
    </>
  );
}
