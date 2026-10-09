/**
 * Access › Connectors rows — one row per connector someone holds access to,
 * with those grants beneath it (ADR 0115).
 *
 * A row names its connector's source and health and lists who is bound to
 * it. Bind opens one form under one row to grant one more; Configure opens
 * that connector's sealed access settings; a Connections row links back to
 * where the connector itself is configured. Revoke asks nothing twice — a
 * binding is time-boxed already, and the ledger records the revocation.
 */

import type { ConnectorSetting } from "@opensesame/app-core/lib/connector-settings.js";
import {
  type PendingShare,
  policyLabel,
} from "@opensesame/app-core/lib/local-share-grants-approvals.js";
import type { LocalShare } from "@opensesame/app-core/lib/local-share-grants.js";
import { IconKey } from "../../components/IconKey.js";
import { IconCheck, IconTrash, IconX } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
import { AccessDetail, AccessFact } from "./AccessRecords.js";
import { ConnectorBindForm } from "./ConnectorBindForm.js";
import { ConnectorSettingsForm } from "./ConnectorSettingsForm.js";
import { RowActions, bindButtonId } from "./connector-row-actions.js";
import { formatTime } from "./format.js";
import type {
  ConnectorIdentity,
  ConnectorRow,
  useConnectorAccess,
} from "./useConnectorAccess.js";

export { bindButtonId };

function BindingRow({
  share,
  name,
  providerWide,
  busy,
  disabled,
  onRevoke,
}: {
  share: LocalShare;
  name: string;
  /** Granted on the provider, so it covers every connection of it. */
  providerWide: boolean;
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
      {providerWide ? (
        <span
          className="chip"
          title={`Every ${share.resourceLabel} connection`}
        >
          all {share.resourceLabel}
        </span>
      ) : null}
      <span className="access-binding__until">
        until {formatTime(new Date(share.expiresAt).toISOString())}
      </span>
      {disabled ? <StatusMark tone="warn" label="Connector off" /> : null}
      <button
        type="button"
        className="icon-btn icon-btn--sm"
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

/** Agent grants on this connector that are not active yet. */
function PendingBindings({
  displayName,
  pending,
  identities,
  busy,
  onApprove,
  onDeny,
}: {
  displayName: string;
  pending: readonly PendingShare[];
  identities: readonly ConnectorIdentity[];
  busy: boolean;
  onApprove: (id: string) => void;
  onDeny: (id: string) => void;
}) {
  if (pending.length === 0) return null;
  const names = new Map(identities.map((entry) => [entry.id, entry.name]));
  return (
    <ul
      className="access-bindings"
      aria-label={`Awaiting approval for ${displayName}`}
    >
      {pending.map((row) => {
        const name = names.get(row.principalId) ?? row.principalId;
        return (
          <li key={row.id} className="access-binding">
            <strong>{name}</strong>
            <span className="access-binding__policy">
              {policyLabel("connection", row.policy)}
            </span>
            <StatusMark tone="warn" label="Awaiting approval" />
            <IconKey
              label={`Approve ${name}`}
              small
              disabled={busy}
              onClick={() => onApprove(row.id)}
            >
              <IconCheck size={16} />
            </IconKey>
            <IconKey
              label={`Deny ${name}`}
              small
              disabled={busy}
              onClick={() => onDeny(row.id)}
            >
              <IconX size={16} />
            </IconKey>
          </li>
        );
      })}
    </ul>
  );
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
      ) : row.healthy === null ? null : (
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
  rowId,
  displayName,
  setting,
  bindings,
  identities,
  busy,
  onRevoke,
}: {
  rowId: string;
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
          providerWide={share.resourceId !== rowId}
          busy={busy}
          disabled={!setting.enabled}
          onRevoke={() => onRevoke(share)}
        />
      ))}
    </ul>
  );
}

type ConnectorRowItemProps = {
  row: ConnectorRow;
  setting: ConnectorSetting;
  bindings: readonly LocalShare[];
  identities: readonly ConnectorIdentity[];
  pending: readonly PendingShare[];
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
  onApprove: (id: string) => void;
  onDeny: (id: string) => void;
};

function ConnectorRowItem({
  row,
  setting,
  bindings,
  identities,
  pending,
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
  onApprove,
  onDeny,
}: ConnectorRowItemProps) {
  const displayName = setting.alias || row.name;
  return (
    <AccessDetail
      title={displayName}
      kind="Connector access"
      actions={
        <>
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
        </>
      }
    >
      <AccessFact label="Connection" value={row.detail} />
      <AccessFact label="Reference" value={row.id} />
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
        rowId={row.id}
        displayName={displayName}
        setting={setting}
        bindings={bindings}
        identities={identities}
        busy={busy}
        onRevoke={onRevoke}
      />
      <PendingBindings
        displayName={displayName}
        pending={pending}
        identities={identities}
        busy={busy}
        onApprove={onApprove}
        onDeny={onDeny}
      />
    </AccessDetail>
  );
}

/** The rows, each with its bindings and its open form at most. */
export function ConnectorRows({
  state,
  rows,
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
  state: ReturnType<typeof useConnectorAccess>;
  rows: readonly ConnectorRow[];
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
  if (rows.length === 0) return null;
  return (
    <section aria-label="Connector access">
      {rows.map((row) => (
        <ConnectorRowItem
          key={row.id}
          row={row}
          setting={state.settingsFor(row)}
          bindings={state.bindingsFor(row)}
          identities={state.identities}
          pending={state.pendingFor(row)}
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
          onApprove={(id) => void state.approve(id)}
          onDeny={(id) => void state.deny(id)}
        />
      ))}
    </section>
  );
}
