import { useState } from "react";
import { IconAlert, IconSearch } from "../../components/Icons.js";
import type { Connection } from "../../lib/connections.js";
import type { SecretItem } from "../../lib/vault/model.js";
import type { GrantTarget } from "./grant-ceremony-types.js";

export function localDeviceConnection(): Connection {
  return {
    connectionId: "conn_local",
    connectionRef: "local",
    logicalName: "local",
    displayName: "this device",
    providerId: "local",
    integrationId: null,
    status: "active",
    statusDetail: null,
    organizationId: "",
    projectId: null,
    ownerKind: "device",
    shareability: "private",
    requestedScopes: [],
    grantedScopes: [],
    accountLabel: null,
    expiresAt: null,
    refreshable: false,
    lastRefreshedAt: null,
    maxInvokeLevel: 0,
    egress: { scheme: "https", authorities: [], pathPrefixes: [] },
    bindings: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export function connectionMatches(
  connection: Connection,
  query: string,
): boolean {
  const haystack = [
    connection.displayName,
    connection.logicalName,
    connection.connectionRef,
    connection.providerId,
  ]
    .join("\n")
    .toLowerCase();
  return haystack.includes(query);
}

export function secretMatches(item: SecretItem, query: string): boolean {
  const haystack = [item.name, item.connectionRef].join("\n").toLowerCase();
  return haystack.includes(query);
}

export function TargetStep({
  connections,
  loadError,
  secrets,
  vaultStatus,
  onPick,
  onRetry,
}: {
  connections: Connection[] | null;
  loadError: string | null;
  secrets: SecretItem[];
  vaultStatus: string;
  onPick: (target: GrantTarget) => void;
  onRetry: () => void;
}) {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const shownConnections = (connections ?? []).filter(
    (connection) => !needle || connectionMatches(connection, needle),
  );
  const shownSecrets = secrets.filter(
    (item) => !needle || secretMatches(item, needle),
  );

  return (
    <>
      <div className="field access-search">
        <label className="label" htmlFor="grant-target-search">
          <IconSearch /> Search targets
        </label>
        <input
          id="grant-target-search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Name or reference…"
          spellCheck={false}
          autoComplete="off"
        />
      </div>

      {loadError ? (
        <p className="note note--err" role="alert">
          <IconAlert /> {loadError}{" "}
          <button type="button" className="btn btn--sm" onClick={onRetry}>
            Retry
          </button>
        </p>
      ) : null}

      {connections === null && !loadError ? (
        <output className="note">Asking the Host…</output>
      ) : null}

      <h3 className="access-group__label">This device</h3>
      <ul className="access-targets">
        <li>
          <button
            type="button"
            className="access-target"
            onClick={() =>
              onPick({
                kind: "connection",
                connection: localDeviceConnection(),
              })
            }
          >
            <span className="access-target__name">this device</span>
            <code className="access-ref">local</code>
          </button>
        </li>
      </ul>

      {connections !== null &&
      (shownConnections.length > 0 || connections.length > 0 || needle) ? (
        <>
          <h3 className="access-group__label">Connections</h3>
          {shownConnections.length > 0 ? (
            <ul className="access-targets">
              {shownConnections.map((connection) => (
                <li key={connection.connectionId}>
                  <button
                    type="button"
                    className="access-target"
                    onClick={() => onPick({ kind: "connection", connection })}
                  >
                    <span className="access-target__name">
                      {connection.displayName}
                    </span>
                    <code className="access-ref">
                      {connection.connectionRef}
                    </code>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="hint">No connections match.</p>
          )}
        </>
      ) : null}

      {vaultStatus === "unlocked" ? (
        <>
          <h3 className="access-group__label">Secrets</h3>
          {shownSecrets.length > 0 ? (
            <ul className="access-targets">
              {shownSecrets.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    className="access-target"
                    onClick={() => onPick({ kind: "secret", secret: item })}
                  >
                    <span className="access-target__name">{item.name}</span>
                    <code className="access-ref">
                      {item.connectionRef.trim() || "—"}
                    </code>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="hint">No secrets match.</p>
          )}
        </>
      ) : vaultStatus === "locked" ? (
        <p className="hint">Unlock the vault to grant secrets.</p>
      ) : null}
    </>
  );
}
