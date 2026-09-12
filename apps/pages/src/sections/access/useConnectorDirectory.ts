/**
 * Everything Access › Connectors reads and changes (ADR 0115).
 *
 * The rows are two lists made one: the connections a Nango-compatible
 * directory holds (sealed in this tomb) and, where a Host is configured, the
 * connections the Host brokers. A binding is a local share grant of kind
 * `connection` — the same ledger Identity shares use — so the PAM question
 * "who may use which connector, under which policy, until when" has one
 * answer wherever it is asked.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type Connection, listConnections } from "../../lib/connections.js";
import {
  type ConnectorDirectory,
  connectorResourceId,
  connectorResourceLabel,
  readConnectorDirectory,
  readDirectoryEndpoint,
  syncConnectorDirectory,
} from "../../lib/connector-directory.js";
import { readLocalDirectory } from "../../lib/local-directory.js";
import { subscribeLocalIamChanges } from "../../lib/local-iam-events.js";
import {
  type LocalShare,
  createLocalShare,
  listLocalShares,
  revokeLocalShare,
} from "../../lib/local-share-grants.js";
import { useHostConfigured } from "../../lib/use-configured.js";

export type ConnectorRow = Readonly<{
  /** The share-grant resource id. */
  id: string;
  /** The share-grant resource label. */
  label: string;
  /** Which brand mark the row wears. */
  providerId: string;
  name: string;
  /** `integration · connection id`, or the Host's reference. */
  detail: string;
  source: "directory" | "host";
  healthy: boolean;
  /** What is wrong, when something is. */
  problem: string | null;
}>;

export type ConnectorIdentity = Readonly<{ id: string; name: string }>;

export type BindInput = {
  principalId: string;
  policy: string;
  durationSeconds: number;
};

type Loaded = {
  directory: ConnectorDirectory | null;
  connections: Connection[];
  shares: LocalShare[];
  identities: ConnectorIdentity[];
};

function directoryRows(directory: ConnectorDirectory | null): ConnectorRow[] {
  return (directory?.connections ?? []).map((connection) => ({
    id: connectorResourceId(connection),
    label: connectorResourceLabel(connection),
    providerId: connection.provider,
    name: connectorResourceLabel(connection),
    detail: `${connection.integrationId} · ${connection.connectionId}`,
    source: "directory",
    healthy: connection.errors === 0,
    problem:
      connection.errors === 0
        ? null
        : `${connection.errors} ${connection.errors === 1 ? "error" : "errors"}`,
  }));
}

function hostRows(connections: readonly Connection[]): ConnectorRow[] {
  return connections
    .filter((connection) => connection.status !== "revoked")
    .map((connection) => ({
      id: `host:${connection.connectionId}`.slice(0, 128),
      label: connection.displayName.slice(0, 128),
      providerId: connection.providerId,
      name: connection.displayName,
      detail: `${connection.providerId} · ${connection.connectionRef ?? connection.connectionId}`,
      source: "host",
      healthy: connection.status === "active",
      problem:
        connection.status === "active"
          ? null
          : (connection.statusDetail ?? connection.status),
    }));
}

async function readHostConnections(configured: boolean): Promise<Connection[]> {
  if (!configured) return [];
  try {
    return await listConnections();
  } catch {
    // A Host that does not answer is not this panel's failure to report:
    // the connectivity bar already says so, and the directory rows stand.
    return [];
  }
}

async function readIdentities(tomb: string): Promise<ConnectorIdentity[]> {
  const directory = await readLocalDirectory(tomb);
  return directory.entries
    .filter(
      (entry) =>
        (entry.kind === "person" || entry.kind === "agent") && entry.enabled,
    )
    .map((entry) => ({ id: entry.id, name: entry.name }));
}

async function readAll(tomb: string, hostConfigured: boolean): Promise<Loaded> {
  const [directory, connections, granted, identities] = await Promise.all([
    readConnectorDirectory(tomb),
    readHostConnections(hostConfigured),
    listLocalShares(tomb),
    readIdentities(tomb),
  ]);
  return {
    directory,
    connections,
    shares: granted.filter((share) => share.resourceKind === "connection"),
    identities,
  };
}

/** The panel's reads: once on mount, on every ledger change, and on focus. */
function useConnectorReads(tomb: string) {
  const hostConfigured = useHostConfigured();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState("");
  const alive = useRef(false);
  const generation = useRef(0);

  const reload = useCallback(async () => {
    const request = ++generation.current;
    try {
      const next = await readAll(tomb, hostConfigured);
      if (!alive.current || request !== generation.current) return;
      setLoaded(next);
      setError("");
    } catch {
      if (!alive.current || request !== generation.current) return;
      setError("Unlock this vault and reload to read its connectors.");
    }
  }, [tomb, hostConfigured]);

  useEffect(() => {
    alive.current = true;
    const refresh = () => void reload();
    const unsubscribe = subscribeLocalIamChanges(refresh);
    window.addEventListener("focus", refresh);
    refresh();
    return () => {
      alive.current = false;
      generation.current++;
      unsubscribe();
      window.removeEventListener("focus", refresh);
    };
  }, [reload]);

  return { loaded, error, setError, reload, alive };
}

export function useConnectorDirectory(tomb: string) {
  const reads = useConnectorReads(tomb);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const directory = reads.loaded?.directory ?? null;
  const shares = reads.loaded?.shares ?? [];
  const connections = reads.loaded?.connections ?? [];

  async function run(action: () => Promise<string>): Promise<boolean> {
    if (busy) return false;
    setBusy(true);
    setMessage("");
    reads.setError("");
    try {
      const said = await action();
      if (reads.alive.current) setMessage(said);
      await reads.reload();
      return true;
    } catch (caught) {
      if (reads.alive.current)
        reads.setError(
          caught instanceof Error ? caught.message : "That did not work.",
        );
      return false;
    } finally {
      if (reads.alive.current) setBusy(false);
    }
  }

  const rows = useMemo(
    () => [...directoryRows(directory), ...hostRows(connections)],
    [directory, connections],
  );

  return {
    directory,
    endpoint: directory?.endpoint ?? readDirectoryEndpoint(),
    rows,
    identities: reads.loaded?.identities ?? [],
    loaded: reads.loaded !== null,
    busy,
    error: reads.error,
    message,
    reload: reads.reload,
    bindingsFor: (row: ConnectorRow) =>
      shares.filter((share) => share.resourceId === row.id),
    bind: (row: ConnectorRow, input: BindInput) =>
      run(async () => {
        await createLocalShare(tomb, {
          principalId: input.principalId,
          resourceKind: "connection",
          resourceId: row.id,
          resourceLabel: row.label,
          policy: input.policy,
          durationSeconds: input.durationSeconds,
        });
        return `${row.name} bound.`;
      }),
    revoke: (share: LocalShare) =>
      run(async () => {
        await revokeLocalShare(tomb, share.id);
        return "Binding revoked.";
      }),
    sync: (key?: string) =>
      run(async () => {
        const record = await syncConnectorDirectory({
          endpoint: directory?.endpoint ?? readDirectoryEndpoint(),
          key: key ?? directory?.key ?? "",
          tomb,
        });
        const count = record.connections.length;
        return `${count} ${count === 1 ? "connector" : "connectors"} synced.`;
      }),
  };
}
