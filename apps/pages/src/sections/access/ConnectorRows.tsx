/**
 * Access › Connectors rows — one row per connector someone holds access to,
 * with those grants beneath it (ADR 0115).
 */

import type { ConnectorSetting } from "@opensesame/app-core/lib/connector-settings.js";
import type { LocalShare } from "@opensesame/app-core/lib/local-share-grants.js";
import { ConnectorRowItem } from "./ConnectorRowItem.js";
import { bindButtonId } from "./connector-row-actions.js";
import type { ConnectorRow, useConnectorAccess } from "./useConnectorAccess.js";

export { bindButtonId };

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
    <ul className="identity-rows" aria-label="Connector access">
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
    </ul>
  );
}
