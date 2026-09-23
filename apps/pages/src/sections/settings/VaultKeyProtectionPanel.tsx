import { loadSettings } from "@opensesame/app-core/lib/settings.js";
import {
  LIFECYCLE_NOT_READY_REASON,
  preferenceMechanismLabel,
  selectProtectionView,
} from "@opensesame/app-core/lib/vault/protection/protection-view.js";
import { type Ref, useMemo, useState } from "react";
import { IconAlert, IconPlus } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
import { useVault } from "../../lib/vault/hooks.js";
import { useGuideTarget } from "../../tutorial/registry/react.jsx";
import {
  type ProtectionSheetRequest,
  VaultKeyProtectionSheet,
} from "./VaultKeyProtectionCeremonies.js";
import { ProtectorRow } from "./VaultProtectorRow.js";
import { useVaultKeyProtectionActions } from "./useVaultKeyProtectionActions.js";
import "./vault-key-protection.css";
import {
  type VaultKeyProtectionActions,
  resolveActions,
} from "@opensesame/app-core/sections/settings/vault-key-protection-panel-model.js";

type ProtectionView = ReturnType<typeof selectProtectionView>;

function VaultKeyProtectionBody({
  panelRef,
  view,
  wired,
  disabledReason,
  actions,
}: {
  panelRef: Ref<HTMLElement>;
  view: ProtectionView;
  wired: boolean;
  disabledReason: string | undefined;
  actions: Required<VaultKeyProtectionActions>;
}) {
  return (
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
            title={disabledReason ?? "Add key protection method"}
            disabled={!wired}
            onClick={actions.onAdd}
          >
            <IconPlus size={16} />
          </button>
          <button
            type="button"
            className="icon-btn icon-btn--sm"
            aria-label="Rotate compromised vault key"
            title={disabledReason ?? "Rotate compromised vault key"}
            disabled={!wired}
            onClick={actions.onRotateCompromised}
          >
            <IconAlert size={16} />
          </button>
        </div>
      </div>
      <div className="panel__body">
        <fieldset className="vkp__policy">
          <legend className="sr-only">Protection policy</legend>
          <StatusMark tone="ok" label="Any enrolled method can unlock alone" />
          <StatusMark tone="idle" label="Remove does not erase backups" />
          <StatusMark tone="warn" label="Cloud adds independent authority" />
        </fieldset>

        {view.methods.length === 0 && !view.setupIntent ? (
          <div className="sw sw--method">
            <div>
              <div className="sw__name">
                No enrolled method
                <StatusMark tone="idle" label="None enrolled" />
              </div>
            </div>
          </div>
        ) : null}

        {view.methods.map((row) => (
          <ProtectorRow
            key={row.protectorId}
            row={row}
            preferred={view.preferredProtectorId === row.protectorId}
            disabledReason={disabledReason}
            actionsWired={wired}
            onTest={actions.onTest}
            onPreferred={actions.onPreferred}
            onRemove={actions.onRemove}
          />
        ))}

        {view.setupIntent ? (
          <div className="sw sw--method" data-testid="setup-intent">
            <div>
              <div className="sw__name">
                {preferenceMechanismLabel(view.setupIntent.providerId)}
                <StatusMark tone="warn" label="Setup intent" />
              </div>
              <p className="sw__sub">{view.setupIntent.providerId}</p>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}

/**
 * Settings › Security › Vault key protection — authority view for enrolled
 * key protection methods. Encryption connector preference is setup intent
 * only (KP-04), never enrolled.
 */
export function VaultKeyProtectionPanel({
  actions: actionsProp,
}: {
  actions?: VaultKeyProtectionActions;
} = {}) {
  const { header, guest } = useVault();
  const [sheet, setSheet] = useState<ProtectionSheetRequest | null>(null);
  const panelRef = useGuideTarget<HTMLElement>("settings.vault-key-protection");
  const view = useMemo(() => {
    const encryption =
      loadSettings().capabilityConnectors?.encryption ?? undefined;
    return selectProtectionView({
      header: guest ? null : header,
      encryptionBinding: encryption,
    });
  }, [guest, header]);
  const defaultActions = useVaultKeyProtectionActions({
    openSheet: setSheet,
    methodKind: (id) =>
      view.methods.find((row) => row.protectorId === id)?.kind,
  });
  const resolved = actionsProp ?? defaultActions;
  const actions = resolveActions(resolved);
  const wired = Boolean(
    resolved?.onAdd &&
      resolved.onTest &&
      resolved.onPreferred &&
      resolved.onRemove &&
      resolved.onRotateCompromised,
  );
  const disabledReason = wired ? undefined : LIFECYCLE_NOT_READY_REASON;

  return (
    <>
      <VaultKeyProtectionBody
        panelRef={panelRef}
        view={view}
        wired={wired}
        disabledReason={disabledReason}
        actions={actions}
      />
      {sheet ? (
        <VaultKeyProtectionSheet
          request={sheet}
          onClose={() => setSheet(null)}
          onReplace={setSheet}
        />
      ) : null}
    </>
  );
}
