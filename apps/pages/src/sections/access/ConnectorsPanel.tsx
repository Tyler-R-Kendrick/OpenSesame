/**
 * Access › Connectors — the connectors this device knows, and who is bound
 * to each (ADR 0115).
 *
 * A directory row names where the list came from and when; every connector
 * beneath it is a terse row with its bindings listed under it. Bind opens
 * one form under one row; Revoke asks nothing twice — a binding is
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
import {
  type ConnectorDirectory,
  directoryOriginLabel,
} from "../../lib/connector-directory.js";
import { keyboardIsIdle } from "../../lib/focus.js";
import { type LocalShare, policyLabel } from "../../lib/local-share-grants.js";
import { ConnectorMark } from "../connections/ConnectorMark.js";
import { ConnectorBindForm } from "./ConnectorBindForm.js";
import { formatTime } from "./format.js";
import {
  type ConnectorIdentity,
  type ConnectorRow,
  useConnectorDirectory,
} from "./useConnectorDirectory.js";

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

function BindingRow({
  share,
  name,
  busy,
  onRevoke,
}: {
  share: LocalShare;
  name: string;
  busy: boolean;
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
      <button
        type="button"
        className="btn btn--sm btn--danger"
        disabled={busy}
        onClick={onRevoke}
      >
        Revoke
      </button>
    </li>
  );
}

function ConnectorRowItem({
  row,
  bindings,
  identities,
  names,
  busy,
  binding,
  onOpenBind,
  onCloseBind,
  onBind,
  onRevoke,
}: {
  row: ConnectorRow;
  bindings: readonly LocalShare[];
  identities: readonly ConnectorIdentity[];
  names: ReadonlyMap<string, string>;
  busy: boolean;
  binding: boolean;
  onOpenBind: (button: HTMLButtonElement) => void;
  onCloseBind: () => void;
  onBind: (input: {
    principalId: string;
    policy: string;
    durationSeconds: number;
  }) => void;
  onRevoke: (share: LocalShare) => void;
}) {
  return (
    <li className="identity-row">
      <div className="identity-row__main">
        <ConnectorMark
          providerId={row.providerId}
          displayName={row.name}
          size={32}
        />
        <div className="identity-row__id">
          <h3>{row.name}</h3>
          <code className="identity-ref">{row.detail}</code>
        </div>
        <span className="chip">{row.source}</span>
        <span className={`chip ${row.healthy ? "chip--ok" : "chip--warn"}`}>
          {row.healthy ? "Authorized" : row.problem}
        </span>
        <span className="chip">{bindings.length} bound</span>
        <div className="actions">
          <button
            type="button"
            className="btn btn--sm"
            disabled={busy || binding}
            onClick={(event) => onOpenBind(event.currentTarget)}
          >
            Bind
          </button>
        </div>
      </div>
      {binding ? (
        <ConnectorBindForm
          connector={row.name}
          identities={identities}
          busy={busy}
          onCancel={onCloseBind}
          onBind={onBind}
        />
      ) : null}
      {bindings.length > 0 ? (
        <ul className="access-bindings" aria-label={`Bound to ${row.name}`}>
          {bindings.map((share) => (
            <BindingRow
              key={share.id}
              share={share}
              name={names.get(share.principalId) ?? share.principalId}
              busy={busy}
              onRevoke={() => onRevoke(share)}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/** Where the list came from and when — one ruled line above the rows. */
function DirectoryLine({ directory }: { directory: ConnectorDirectory }) {
  const count = directory.connections.length;
  return (
    <p className="access-directory">
      <IconConnection size={15} />
      <code className="access-ref">
        {directoryOriginLabel(directory.endpoint)}
      </code>
      <span className="chip">
        {count} {count === 1 ? "connector" : "connectors"}
      </span>
      <span className="access-directory__when">
        synced {formatTime(directory.syncedAt)}
      </span>
    </p>
  );
}

export function ConnectorsPanel({ tomb }: { tomb: string }) {
  const state = useConnectorDirectory(tomb);
  const [editing, setEditing] = useState(false);
  const [bindingRow, setBindingRow] = useState<string | null>(null);
  const [trigger, setTrigger] = useState<HTMLButtonElement | null>(null);
  const names = new Map(
    state.identities.map((entry) => [entry.id, entry.name]),
  );
  const showForm = editing || (state.loaded && !state.directory);

  function closeBind() {
    setBindingRow(null);
    requestAnimationFrame(() => {
      if (keyboardIsIdle() && trigger?.isConnected) trigger.focus();
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
        <output>{state.message}</output>
        {state.directory ? <DirectoryLine directory={state.directory} /> : null}
        {showForm ? (
          <ConnectorDirectoryForm
            tomb={tomb}
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
        {state.rows.length > 0 ? (
          <ul className="identity-rows">
            {state.rows.map((row) => (
              <ConnectorRowItem
                key={row.id}
                row={row}
                bindings={state.bindingsFor(row)}
                identities={state.identities}
                names={names}
                busy={state.busy}
                binding={bindingRow === row.id}
                onOpenBind={(button) => {
                  setTrigger(button);
                  setBindingRow(row.id);
                }}
                onCloseBind={closeBind}
                onBind={(input) =>
                  void state.bind(row, input).then((done) => {
                    if (done) closeBind();
                  })
                }
                onRevoke={(share) => void state.revoke(share)}
              />
            ))}
          </ul>
        ) : null}
      </div>
    </section>
  );
}
