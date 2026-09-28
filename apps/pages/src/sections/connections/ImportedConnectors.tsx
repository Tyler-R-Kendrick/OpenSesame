/**
 * Connectors imported from a Nango-compatible directory (ADR 0115), listed on
 * the Connections page beside the ones configured here.
 *
 * The list is sealed in this vault's tomb with the key that read it; nothing
 * here ever holds a provider token. One key re-reads the directory with that
 * key. Who may use an imported connector is decided on Access › Connectors,
 * like any other.
 */

import {
  type ConnectorDirectory,
  directoryOriginLabel,
  readConnectorDirectory,
  syncConnectorDirectory,
} from "@opensesame/app-core/lib/connector-directory.js";
import { subscribeLocalIamChanges } from "@opensesame/app-core/lib/local-iam-events.js";
import { tombUnlocked } from "@opensesame/app-core/lib/vfs.js";
import type { Flash } from "@opensesame/app-core/sections/connections/shared.js";
import { useCallback, useEffect, useState } from "react";
import { IconRefresh } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
import { formatTime } from "../access/format.js";
import { ConnectorMark } from "./ConnectorMark.js";

export const importedConnectorsSeams = {
  readConnectorDirectory,
  syncConnectorDirectory,
  tombUnlocked,
};

/** The imported list, re-read whenever the vault's ledger says it changed. */
export function useImportedDirectory(tomb: string) {
  const [record, setRecord] = useState<ConnectorDirectory | null>(null);
  const [busy, setBusy] = useState(false);
  const reload = useCallback(async () => {
    if (!tomb || !importedConnectorsSeams.tombUnlocked(tomb)) {
      setRecord(null);
      return;
    }
    try {
      setRecord(await importedConnectorsSeams.readConnectorDirectory(tomb));
    } catch {
      setRecord(null);
    }
  }, [tomb]);
  useEffect(() => {
    void reload();
    return subscribeLocalIamChanges(() => void reload());
  }, [reload]);

  async function resync(onFlash: (flash: Flash) => void) {
    if (!record || busy) return;
    setBusy(true);
    try {
      const next = await importedConnectorsSeams.syncConnectorDirectory({
        endpoint: record.endpoint,
        key: record.key,
        tomb,
      });
      const count = next.connections.length;
      onFlash({
        tone: "ok",
        text: `${count} ${count === 1 ? "connector" : "connectors"} imported from ${directoryOriginLabel(next.endpoint)}.`,
      });
      await reload();
    } catch (error) {
      onFlash({
        tone: "err",
        text:
          error instanceof Error
            ? error.message
            : "The directory did not answer.",
      });
    } finally {
      setBusy(false);
    }
  }

  return { record, busy, reload, resync };
}

/** The imported connectors, as one group under Connected. */
export function ImportedGroup({
  record,
  busy,
  onResync,
}: {
  record: ConnectorDirectory;
  busy: boolean;
  onResync: () => void;
}) {
  const origin = directoryOriginLabel(record.endpoint);
  const count = record.connections.length;
  return (
    <div className="conn-group conn-imported" id="connected-imported">
      <div className="conn-imported__head">
        <h3 className="conn-group__label">
          {origin} · {count} {count === 1 ? "connector" : "connectors"} · synced{" "}
          {formatTime(record.syncedAt)}
        </h3>
        <button
          type="button"
          className="icon-btn icon-btn--sm"
          aria-label={`Import again from ${origin}`}
          title={`Import again from ${origin}`}
          disabled={busy}
          onClick={onResync}
        >
          <IconRefresh size={15} />
        </button>
      </div>
      {count === 0 ? null : (
        <ul className="conn-list" aria-label={`Imported from ${origin}`}>
          {record.connections.map((connection) => (
            <li
              className="conn-service"
              key={`${connection.integrationId}/${connection.connectionId}`}
            >
              <ConnectorMark
                providerId={connection.provider}
                displayName={connection.displayName}
              />
              <div className="conn-service__copy">
                <h3>
                  {connection.displayName}
                  {connection.endUser ? ` · ${connection.endUser}` : ""}
                </h3>
                <p>
                  {connection.integrationId} · {connection.connectionId}
                </p>
              </div>
              <div className="conn-service__actions">
                <StatusMark
                  tone={connection.errors === 0 ? "ok" : "warn"}
                  label={
                    connection.errors === 0
                      ? "Authorized"
                      : `${connection.errors} ${connection.errors === 1 ? "error" : "errors"}`
                  }
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
