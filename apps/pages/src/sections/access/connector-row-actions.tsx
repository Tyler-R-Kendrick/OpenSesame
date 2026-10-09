/**
 * Bind, configure, and open actions on one Access connector row.
 * The row file stays under the line budget by keeping these verbs here.
 */

import type { ConnectorSetting } from "@opensesame/app-core/lib/connector-settings.js";
import { Link } from "react-router";
import { useConnectorRoads } from "../../bindings/connector-roads.js";
import {
  IconCheck,
  IconConnection,
  IconSettings,
} from "../../components/Icons.js";
import type { ConnectorRow } from "./useConnectorAccess.js";

/** Where the keyboard returns when a row's bind form closes. */
export function bindButtonId(rowId: string): string {
  return `connector-bind-${rowId}`;
}

/** The row's verbs. The forms beneath carry them while open — one Bind or
    Configure per card, never a disabled twin beside it. */
export function RowActions({
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
  const { pages } = useConnectorRoads();
  // A grant on a connector this device does not list can only be revoked:
  // there is nothing here to bind it to or configure.
  if (row.source === "unlisted") return null;
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
      {row.href && pages ? (
        <Link
          className="icon-btn icon-btn--sm"
          to={row.href}
          aria-label="Open in Connections"
          title="Open in Connections"
        >
          <IconConnection size={16} />
        </Link>
      ) : null}
    </div>
  );
}
