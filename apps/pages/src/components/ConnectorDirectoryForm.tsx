/**
 * The connector directory, asked for once (ADR 0115).
 *
 * Two fields and one in-card action, shared by the setup ceremony's
 * connectors tab and Access › Connectors so the endpoint means the same thing
 * in both places. The endpoint commits on blur into the plaintext record; the
 * key is held only for the sync, then sealed with the list — this component
 * never writes it anywhere itself.
 */

import { useState } from "react";
import {
  type ConnectorDirectory,
  directoryOriginLabel,
  pendingConnectorDirectory,
  readDirectoryEndpoint,
  syncConnectorDirectory,
  writeDirectoryEndpoint,
} from "../lib/connector-directory.js";
import {
  HOSTED_DIRECTORY,
  SHIPPED_LOCAL_DIRECTORY,
  normalizeDirectoryEndpoint,
} from "../lib/nango-directory.js";
import { pageIsLoopback } from "../lib/settings.js";
import { type FieldFill, FieldShell } from "./FieldShell.js";
import { IconConnection, IconSecret } from "./Icons.js";
import { type StatusMessage, StatusNote } from "./StatusNote.js";

export const connectorDirectoryFormDependencies = {
  readDirectoryEndpoint,
  writeDirectoryEndpoint,
  syncConnectorDirectory,
  pendingConnectorDirectory,
  pageIsLoopback,
};

/** What a finished sync says, in one line. */
function synced(record: ConnectorDirectory, sealed: boolean): string {
  const count = record.connections.length;
  const where = directoryOriginLabel(record.endpoint);
  if (count === 0) {
    return `Nothing is authorized at ${where} yet. Authorize a connection there and sync again.`;
  }
  const noun = count === 1 ? "connector" : "connectors";
  const then = sealed
    ? ""
    : " They are sealed into the vault the moment you sign in or continue as a guest.";
  return `${count} ${noun} found at ${where}.${then}`;
}

/** The sync round trip and what it left on screen. */
function useDirectorySync(
  tomb: string | null,
  onSynced?: (record: ConnectorDirectory) => void,
) {
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<StatusMessage | null>(null);
  function sync(endpoint: string, key: string) {
    setBusy(true);
    setFlash(null);
    void connectorDirectoryFormDependencies
      .syncConnectorDirectory({ endpoint, key, tomb })
      .then((record) => {
        setFlash({ tone: "ok", text: synced(record, tomb !== null) });
        onSynced?.(record);
      })
      .catch((caught) => {
        setFlash({
          tone: "err",
          text:
            caught instanceof Error
              ? caught.message
              : "The directory did not answer.",
        });
      })
      .finally(() => setBusy(false));
  }
  return { busy, flash, clear: () => setFlash(null), sync };
}

/** The addresses we can offer instead of asking for: hosted, and loopback. */
function fillsFor(endpoint: string, pick: (next: string) => void): FieldFill[] {
  const fills: FieldFill[] = [];
  if (endpoint !== HOSTED_DIRECTORY) {
    fills.push({
      label: HOSTED_DIRECTORY,
      onPick: () => pick(HOSTED_DIRECTORY),
    });
  }
  if (
    connectorDirectoryFormDependencies.pageIsLoopback() &&
    endpoint !== SHIPPED_LOCAL_DIRECTORY
  ) {
    fills.push({
      label: SHIPPED_LOCAL_DIRECTORY,
      onPick: () => pick(SHIPPED_LOCAL_DIRECTORY),
    });
  }
  return fills;
}

export function ConnectorDirectoryForm({
  tomb,
  initialKey = "",
  terse = false,
  onSynced,
}: {
  /** The open tomb the list seals into, or null before any vault exists. */
  tomb: string | null;
  /** A key the sealed record already holds, offered back for a re-sync. */
  initialKey?: string;
  /** Access forbids prose: labels, fills and one six-word hint, nothing more. */
  terse?: boolean;
  onSynced?: (record: ConnectorDirectory) => void;
}) {
  const deps = connectorDirectoryFormDependencies;
  const [endpoint, setEndpoint] = useState(
    () =>
      deps.pendingConnectorDirectory()?.endpoint ||
      deps.readDirectoryEndpoint(),
  );
  const [key, setKey] = useState(initialKey);
  const { busy, flash, clear, sync } = useDirectorySync(tomb, onSynced);

  function commitEndpoint(raw: string) {
    const typed = raw.trim();
    const next = normalizeDirectoryEndpoint(typed);
    setEndpoint(next ?? typed);
    // A slip while editing never erases what was on record: only an address
    // this page may call, or an emptied field, is written.
    if (next === null && typed !== "") return;
    const value = next ?? "";
    if (value === deps.readDirectoryEndpoint()) return;
    void deps.writeDirectoryEndpoint(value).catch(() => {
      // The sync writes it again; a browser that cannot persist it is already
      // named on the unlock screen.
    });
  }

  return (
    <div className="setup__stack">
      <FieldShell
        id="directory-endpoint"
        label="Directory endpoint"
        type="url"
        mono
        lead={<IconConnection size={17} />}
        placeholder="https://…"
        value={endpoint}
        disabled={busy}
        onValueChange={(next) => {
          setEndpoint(next);
          clear();
        }}
        onCommit={commitEndpoint}
        fills={fillsFor(endpoint, commitEndpoint)}
        hint={
          terse
            ? "Only listings are read — never a token."
            : "The hosted directory, or an instance you run. Only listings are read — never a token."
        }
      />
      <FieldShell
        id="directory-key"
        label="Environment key"
        type="password"
        mono
        autoComplete="off"
        lead={<IconSecret size={17} />}
        value={key}
        disabled={busy}
        onValueChange={(next) => {
          setKey(next);
          clear();
        }}
        hint={
          terse
            ? undefined
            : "Read access is enough. Sealed with the list, never in the clear; leave it empty if the endpoint needs none."
        }
      />
      <div className="actions">
        <button
          type="button"
          className="btn btn--primary"
          disabled={busy || !normalizeDirectoryEndpoint(endpoint)}
          aria-busy={busy}
          onClick={() => sync(endpoint, key)}
        >
          {busy ? "Syncing…" : "Sync connectors"}
        </button>
      </div>
      <StatusNote message={flash} />
    </div>
  );
}
