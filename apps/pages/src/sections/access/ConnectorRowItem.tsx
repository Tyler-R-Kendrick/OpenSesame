/**
 * One Access › Connectors row with chips, actions, forms, and bindings.
 */

import type { ConnectorSetting } from "@opensesame/app-core/lib/connector-settings.js";
import type { PendingShare } from "@opensesame/app-core/lib/local-share-grants-approvals.js";
import type { LocalShare } from "@opensesame/app-core/lib/local-share-grants.js";
import { StatusMark } from "../../components/StatusMark.js";
import { ConnectorMark } from "../connections/ConnectorMark.js";
import { ConnectorBindForm } from "./ConnectorBindForm.js";
import { ConnectorSettingsForm } from "./ConnectorSettingsForm.js";
import { RowActions } from "./connector-row-actions.js";
import { PendingBindings, RowBindings } from "./connector-row-bindings.js";
import type { ConnectorIdentity, ConnectorRow } from "./useConnectorAccess.js";

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

export type ConnectorRowItemProps = {
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

export function ConnectorRowItem({
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
    </li>
  );
}
