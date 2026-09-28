/**
 * Access › Connectors › Add — choose the connector a grant is made on, then
 * who may use it, under which policy, until when (ADR 0115).
 *
 * The choices are the connectors this device knows: configured on the
 * Connections page, or imported there from a directory. A connector nobody
 * has configured yet is not made here: the last choice leads into the
 * Connections ceremony that configures one, and it comes back to this list
 * once it exists.
 */

import type { ConnectorSetting } from "@opensesame/app-core/lib/connector-settings.js";
import type { KeyboardEvent } from "react";
import { Link } from "react-router";
import { IconPlus } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
import { ConnectorMark } from "../connections/ConnectorMark.js";
import { ConnectorBindForm } from "./ConnectorBindForm.js";
import "../connections.css";
import type {
  BindInput,
  ConnectorIdentity,
  ConnectorRow,
} from "./useConnectorAccess.js";

/** Where a connector is configured before anyone can be granted it. */
export const NEW_CONNECTOR_PATH = "/connections#catalog";

function Choice({
  row,
  setting,
  chosen,
  busy,
  onChoose,
}: {
  row: ConnectorRow;
  setting: ConnectorSetting;
  chosen: boolean;
  busy: boolean;
  onChoose: () => void;
}) {
  const name = setting.alias || row.name;
  return (
    <li className="conn-tile">
      <button
        type="button"
        className="conn-tile__link access-pick__choice"
        aria-pressed={chosen}
        disabled={busy || !setting.enabled}
        title={setting.enabled ? name : "Enable the connector first"}
        onClick={onChoose}
      >
        <ConnectorMark
          providerId={row.providerId}
          displayName={name}
          size={32}
        />
        <span className="conn-tile__copy">
          <span className="conn-tile__name">{name}</span>
          <span className="conn-tile__kind">{row.detail}</span>
        </span>
        {setting.enabled ? null : <StatusMark tone="warn" label="Disabled" />}
      </button>
    </li>
  );
}

export function ConnectorPicker({
  rows,
  settingsFor,
  identities,
  busy,
  chosen,
  onChoose,
  onBind,
  onClose,
}: {
  rows: readonly ConnectorRow[];
  settingsFor: (row: ConnectorRow) => ConnectorSetting;
  identities: readonly ConnectorIdentity[];
  busy: boolean;
  /** The connector whose bind form is open under the list, if any. */
  chosen: string | null;
  onChoose: (row: ConnectorRow | null) => void;
  onBind: (row: ConnectorRow, input: BindInput) => void;
  onClose: () => void;
}) {
  const chosenRow = rows.find((row) => row.id === chosen) ?? null;
  function onKeyDown(event: KeyboardEvent<HTMLFieldSetElement>) {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    event.preventDefault();
    onClose();
  }
  return (
    <fieldset
      className="access-pick"
      aria-label="Add connector access"
      onKeyDown={onKeyDown}
    >
      {rows.length === 0 ? (
        <div className="empty">
          <h3>No connectors configured</h3>
        </div>
      ) : null}
      <ul className="conn-grid" aria-label="Choose a connector">
        {rows.map((row) => (
          <Choice
            key={row.id}
            row={row}
            setting={settingsFor(row)}
            chosen={row.id === chosen}
            busy={busy}
            onChoose={() => onChoose(row.id === chosen ? null : row)}
          />
        ))}
        <li className="conn-tile access-pick__new">
          <Link className="conn-tile__link" to={NEW_CONNECTOR_PATH}>
            <span className="access-pick__plus" aria-hidden="true">
              <IconPlus size={18} />
            </span>
            <span className="conn-tile__copy">
              <span className="conn-tile__name">New connector</span>
            </span>
          </Link>
        </li>
      </ul>
      {chosenRow ? (
        <ConnectorBindForm
          key={chosenRow.id}
          connector={settingsFor(chosenRow).alias || chosenRow.name}
          identities={identities}
          busy={busy}
          initialPolicy={settingsFor(chosenRow).defaultPolicy}
          initialDuration={settingsFor(chosenRow).defaultDurationSeconds}
          onCancel={() => onChoose(null)}
          onBind={(input) => onBind(chosenRow, input)}
        />
      ) : null}
    </fieldset>
  );
}
