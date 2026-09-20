/**
 * Access › Connectors — the connectors this device knows, and who is bound
 * to each (ADR 0115).
 *
 * A directory row names where the list came from and when; every connector
 * beneath it is a terse row with its bindings listed under it (see
 * `ConnectorRows.tsx`). Bind opens one form under one row; Configure opens
 * that connector's sealed settings; Revoke asks nothing twice — a binding is
 * time-boxed already, and the ledger records the revocation. No Host is
 * needed for any of it: the directory is sealed in this vault, and the
 * bindings are local share grants.
 */

import { useState } from "react";
import { ConnectorDirectoryForm } from "../../components/ConnectorDirectoryForm.js";
import {
  IconConnection,
  IconDownload,
  IconEdit,
  IconRefresh,
} from "../../components/Icons.js";
import { StatusNote } from "../../components/StatusNote.js";
import {
  type ConnectorDirectory,
  directoryOriginLabel,
} from "../../lib/connector-directory.js";
import { keyboardIsIdle } from "../../lib/focus.js";
import { ConnectorRows, bindButtonId } from "./ConnectorRows.js";
import { formatTime } from "./format.js";
import { useConnectorDirectory } from "./useConnectorDirectory.js";

function ConnectorCommands({
  busy,
  canSync,
  editing,
  onSync,
  onEdit,
  onReload,
}: {
  busy: boolean;
  canSync: boolean;
  editing: boolean;
  onSync: () => void;
  onEdit: () => void;
  onReload: () => void;
}) {
  return (
    <fieldset className="vtree__keys" aria-label="Connector commands">
      <button
        type="button"
        className="icon-btn icon-btn--sm"
        aria-label="Sync the directory"
        title="Sync the directory"
        disabled={busy || !canSync}
        onClick={onSync}
      >
        <IconDownload size={15} />
      </button>
      <button
        type="button"
        className={`icon-btn icon-btn--sm${editing ? " is-on" : ""}`}
        aria-label="Edit the directory"
        title="Edit the directory"
        aria-pressed={editing}
        disabled={busy}
        onClick={onEdit}
      >
        <IconEdit size={15} />
      </button>
      <button
        type="button"
        className="icon-btn icon-btn--sm"
        aria-label="Reload connectors"
        title="Reload connectors"
        disabled={busy}
        onClick={onReload}
      >
        <IconRefresh size={15} />
      </button>
    </fieldset>
  );
}

/** Where the list came from and when — one mono line above the rows. */
function DirectoryLine({ directory }: { directory: ConnectorDirectory }) {
  const count = directory.connections.length;
  return (
    <p className="access-directory">
      <IconConnection size={15} />
      <span>
        {directoryOriginLabel(directory.endpoint)} · {count}{" "}
        {count === 1 ? "connector" : "connectors"} · synced{" "}
        {formatTime(directory.syncedAt)}
      </span>
    </p>
  );
}

export function ConnectorsPanel({ tomb }: { tomb: string }) {
  const state = useConnectorDirectory(tomb);
  const [editing, setEditing] = useState(false);
  const [bindingRow, setBindingRow] = useState<string | null>(null);
  const [settingsRow, setSettingsRow] = useState<string | null>(null);
  const showForm = editing || (state.loaded && !state.directory);
  const mixedSources =
    state.rows.some((row) => row.source === "host") &&
    state.rows.some((row) => row.source === "directory");

  function closeBind() {
    const rowId = bindingRow;
    setBindingRow(null);
    // The row's Bind steps aside while the form is open, so the button that
    // opened it is gone by now; its replacement is where the keyboard lands.
    requestAnimationFrame(() => {
      if (!rowId || !keyboardIsIdle()) return;
      document.getElementById(bindButtonId(rowId))?.focus();
    });
  }

  return (
    <section
      className="panel"
      id="local-connectors"
      aria-label="Connectors"
      aria-busy={state.busy}
    >
      <div className="panel__head">
        <h2>Connectors</h2>
        <ConnectorCommands
          busy={state.busy}
          canSync={Boolean(state.directory)}
          editing={editing}
          onSync={() => void state.sync()}
          onEdit={() => setEditing((value) => !value)}
          onReload={() => void state.reload()}
        />
      </div>
      <div className="panel__body">
        {state.error ? (
          <p className="note note--err" role="alert">
            {state.error}
          </p>
        ) : null}
        {state.directory ? <DirectoryLine directory={state.directory} /> : null}
        <StatusNote
          message={state.message ? { tone: "ok", text: state.message } : null}
        />
        {showForm ? (
          <ConnectorDirectoryForm
            tomb={tomb}
            terse
            initialKey={state.directory?.key ?? ""}
            onSynced={() => {
              setEditing(false);
              void state.reload();
            }}
          />
        ) : null}
        {state.loaded && state.directory && state.rows.length === 0 ? (
          <p>No connectors yet — the directory holds none.</p>
        ) : null}
        <ConnectorRows
          state={state}
          mixedSources={mixedSources}
          bindingRow={bindingRow}
          settingsRow={settingsRow}
          onOpenBind={(row) => {
            setSettingsRow(null);
            setBindingRow(row.id);
          }}
          onCloseBind={closeBind}
          onBind={(row, input) =>
            void state.bind(row, input).then((done) => {
              if (done) closeBind();
            })
          }
          onOpenSettings={(row) => {
            setBindingRow(null);
            setSettingsRow(row.id);
          }}
          onCloseSettings={() => setSettingsRow(null)}
          onSaveSetting={(row, setting) =>
            void state.saveSetting(row, setting).then((done) => {
              if (done) setSettingsRow(null);
            })
          }
          onRevoke={(share) => void state.revoke(share)}
        />
      </div>
    </section>
  );
}
