import { IconCheck, IconSettings, IconTrash } from "../../components/Icons.js";
/**
 * Access › Connectors rows — one row per connector with its bindings beneath
 * it (ADR 0115).
 *
 * A directory row names its source and health; every row lists who is bound
 * to it. Bind opens one form under one row; Configure opens that connector's
 * sealed settings. Revoke asks nothing twice — a binding is time-boxed
 * already, and the ledger records the revocation.
 */

import { StatusMark } from "../../components/StatusMark.js";
import type { ConnectorSetting } from "../../lib/connector-settings.js";
import { type LocalShare, policyLabel } from "../../lib/local-share-grants.js";
import { ConnectorMark } from "../connections/ConnectorMark.js";
import { ConnectorBindForm } from "./ConnectorBindForm.js";
import { ConnectorSettingsForm } from "./ConnectorSettingsForm.js";
import { formatTime } from "./format.js";
import type {
  ConnectorIdentity,
  ConnectorRow,
  useConnectorDirectory,
} from "./useConnectorDirectory.js";

function BindingRow({
  share,
  name,
  busy,
  disabled,
  onRevoke,
}: {
  share: LocalShare;
  name: string;
  busy: boolean;
  disabled: boolean;
  onRevoke: () => void;
}) {
  return (
    <li className="access-binding">
      <strong>{name}</strong>
      <span className="access-binding__policy">
        {policyLabel("connection", share.policy)}
      </span>
      <span className="access-binding__until">
        until {formatTime(new Date(share.expiresAt).toISOString())}
      </span>
      {disabled ? <StatusMark tone="warn" label="Connector off" /> : null}
      <button
        type="button"
        className="icon-btn icon-btn--sm icon-btn--danger"
        disabled={busy}
        aria-label="Revoke"
        title="Revoke"
        onClick={onRevoke}
      >
        <IconTrash size={16} />
      </button>
    </li>
  );
}

/** Where the keyboard returns when a row's bind form closes. */
export function bindButtonId(rowId: string): string {
  return `connector-bind-${rowId}`;
}

/** The row's chips: source, health (or Disabled), and the binding count. */
function RowChips({
  row,
  setting,
  bindings,
  showSource,
}: {
  row: ConnectorRow;
  setting: ConnectorSetting;
  bindings: readonly LocalShare[];
  /** Only when the list mixes sources; a chip on every row says nothing. */
  showSource: boolean;
}) {
  return (
    <span className="access-connector__chips">
      {showSource ? <span className="chip">{row.source}</span> : null}
      {!setting.enabled ? (
        <StatusMark tone="warn" label="Disabled" />
      ) : (
        <StatusMark
          tone={row.healthy ? "ok" : "warn"}
          label={row.healthy ? "Authorized" : (row.problem ?? "Unavailable")}
        />
      )}
      <span className="chip">{bindings.length} bound</span>
    </span>
  );
}

/** The row's bindings, flagged where their connector is off. */
function RowBindings({
  displayName,
  setting,
  bindings,
  identities,
  busy,
  onRevoke,
}: {
  displayName: string;
  setting: ConnectorSetting;
  bindings: readonly LocalShare[];
  identities: readonly ConnectorIdentity[];
  busy: boolean;
  onRevoke: (share: LocalShare) => void;
}) {
  if (bindings.length === 0) return null;
  const names = new Map(identities.map((entry) => [entry.id, entry.name]));
  return (
    <ul className="access-bindings" aria-label={`Bound to ${displayName}`}>
      {bindings.map((share) => (
        <BindingRow
          key={share.id}
          share={share}
          name={names.get(share.principalId) ?? share.principalId}
          busy={busy}
          disabled={!setting.enabled}
          onRevoke={() => onRevoke(share)}
        />
      ))}
    </ul>
  );
}

/** The row's verbs. The forms beneath carry them while open — one Bind or
    Configure per card, never a disabled twin beside it. */
function RowActions({
  row,
  setting,
  busy,
  onOpenBind,
  onOpenSettings,
}: {
  row: ConnectorRow;
  setting: ConnectorSetting;
  busy: boolean;
  onOpenBind: () => void;
  onOpenSettings: () => void;
}) {
  return (
    <div className="actions">
      <button
        id={bindButtonId(row.id)}
        type="button"
        className="icon-btn icon-btn--sm"
        disabled={busy || !setting.enabled}
        aria-label="Bind"
        title={setting.enabled ? "Bind" : "Enable the connector first"}
        onClick={onOpenBind}
      >
        <IconCheck size={16} />
      </button>
      {row.source === "directory" ? (
        <button
          type="button"
          className="icon-btn icon-btn--sm"
          disabled={busy}
          aria-label="Configure"
          title="Configure"
          onClick={onOpenSettings}
        >
          <IconSettings size={16} />
        </button>
      ) : null}
    </div>
  );
}

function ConnectorRowItem({
  row,
  setting,
  bindings,
  identities,
  busy,
  binding,
  configuring,
  showSource,
  onOpenBind,
  onCloseBind,
  onBind,
  onOpenSettings,
  onCloseSettings,
  onSaveSetting,
  onRevoke,
}: {
  row: ConnectorRow;
  setting: ConnectorSetting;
  bindings: readonly LocalShare[];
  identities: readonly ConnectorIdentity[];
  busy: boolean;
  binding: boolean;
  configuring: boolean;
  /** Only when the list mixes sources; a chip on every row says nothing. */
  showSource: boolean;
  onOpenBind: () => void;
  onCloseBind: () => void;
  onBind: (input: {
    principalId: string;
    policy: string;
    durationSeconds: number;
  }) => void;
  onOpenSettings: () => void;
  onCloseSettings: () => void;
  onSaveSetting: (setting: ConnectorSetting) => void;
  onRevoke: (share: LocalShare) => void;
}) {
  const displayName = setting.alias || row.name;
  return (
    <li className="identity-row">
      <div className="identity-row__main">
        <ConnectorMark
          providerId={row.providerId}
          displayName={displayName}
          size={32}
        />
        <div className="identity-row__id">
          <h3>{displayName}</h3>
          <code className="identity-ref">{row.detail}</code>
        </div>
        <RowChips
          row={row}
          setting={setting}
          bindings={bindings}
          showSource={showSource}
        />
        {binding || configuring ? null : (
          <RowActions
            row={row}
            setting={setting}
            busy={busy}
            onOpenBind={onOpenBind}
            onOpenSettings={onOpenSettings}
          />
        )}
      </div>
      {binding ? (
        <ConnectorBindForm
          connector={displayName}
          identities={identities}
          busy={busy}
          initialPolicy={setting.defaultPolicy}
          initialDuration={setting.defaultDurationSeconds}
          onCancel={onCloseBind}
          onBind={onBind}
        />
      ) : null}
      {configuring ? (
        <ConnectorSettingsForm
          connector={displayName}
          initial={setting}
          busy={busy}
          onCancel={onCloseSettings}
          onSave={onSaveSetting}
        />
      ) : null}
      <RowBindings
        displayName={displayName}
        setting={setting}
        bindings={bindings}
        identities={identities}
        busy={busy}
        onRevoke={onRevoke}
      />
    </li>
  );
}

/** The rows, each with its bindings and its open form at most. */
export function ConnectorRows({
  state,
  mixedSources,
  bindingRow,
  settingsRow,
  onOpenBind,
  onCloseBind,
  onBind,
  onOpenSettings,
  onCloseSettings,
  onSaveSetting,
  onRevoke,
}: {
  state: ReturnType<typeof useConnectorDirectory>;
  mixedSources: boolean;
  bindingRow: string | null;
  settingsRow: string | null;
  onOpenBind: (row: ConnectorRow) => void;
  onCloseBind: () => void;
  onBind: (
    row: ConnectorRow,
    input: { principalId: string; policy: string; durationSeconds: number },
  ) => void;
  onOpenSettings: (row: ConnectorRow) => void;
  onCloseSettings: () => void;
  onSaveSetting: (row: ConnectorRow, setting: ConnectorSetting) => void;
  onRevoke: (share: LocalShare) => void;
}) {
  if (state.rows.length === 0) return null;
  return (
    <ul className="identity-rows">
      {state.rows.map((row) => (
        <ConnectorRowItem
          key={row.id}
          row={row}
          setting={state.settingsFor(row)}
          bindings={state.bindingsFor(row)}
          identities={state.identities}
          busy={state.busy}
          binding={bindingRow === row.id}
          configuring={settingsRow === row.id}
          showSource={mixedSources}
          onOpenBind={() => onOpenBind(row)}
          onCloseBind={onCloseBind}
          onBind={(input) => onBind(row, input)}
          onOpenSettings={() => onOpenSettings(row)}
          onCloseSettings={onCloseSettings}
          onSaveSetting={(setting) => onSaveSetting(row, setting)}
          onRevoke={onRevoke}
        />
      ))}
    </ul>
  );
}
