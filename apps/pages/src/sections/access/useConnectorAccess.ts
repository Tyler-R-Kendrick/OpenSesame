/**
 * Everything Access › Connectors reads and changes (ADR 0115).
 *
 * Access › Connectors answers one question: who may use which connector,
 * under which policy, until when. The connectors themselves are configured —
 * or imported from a Nango-compatible directory or Vercel Connect — on the
 * Connections page; here they are only what a grant is made on. A grant is a
 * local share of kind `connection`, the same ledger Identity shares use, so
 * the PAM question has one answer wherever it is asked.
 *
 * `rows` is every connector a grant can be made on: the Connections page's
 * `listConnections()` and the directory list it imported. `granted` is the
 * subset someone holds access to — what the panel lists.
 */

import {
  type Connection,
  listConnections,
} from "@opensesame/app-core/lib/connections.js";
import { catalogProvider } from "@opensesame/app-core/lib/connector-catalog.js";
import {
  type ConnectorDirectory,
  connectorResourceId,
  connectorResourceLabel,
  readConnectorDirectory,
} from "@opensesame/app-core/lib/connector-directory.js";
import {
  type ConnectorSetting,
  readConnectorSettings,
  settingFor,
  writeConnectorSetting,
} from "@opensesame/app-core/lib/connector-settings.js";
import { readLocalDirectory } from "@opensesame/app-core/lib/local-directory.js";
import { subscribeLocalIamChanges } from "@opensesame/app-core/lib/local-iam-events.js";
import {
  type LocalShare,
  createLocalShare,
  listLocalShares,
  revokeLocalShare,
} from "@opensesame/app-core/lib/local-share-grants.js";
import { connectorPath } from "@opensesame/app-core/sections/connections/shared.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export type ConnectorRow = Readonly<{
  /** The share-grant resource id. */
  id: string;
  /** The share-grant resource label. */
  label: string;
  /** Which brand mark the row wears. */
  providerId: string;
  name: string;
  /** `integration · connection id`, or the connection's reference. */
  detail: string;
  /** Where the row came from: imported from a directory, configured on the
      Connections page, a provider-wide grant with no connection of that
      provider here, or a grant whose connector is gone. */
  source: "directory" | "connections" | "provider" | "removed";
  /** The connector's own page on Connections, for a Connections row. */
  href: string | null;
  /** Null where there is no connection whose health could be read. */
  healthy: boolean | null;
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
  settings: Record<string, ConnectorSetting>;
};

function directoryRows(directory: ConnectorDirectory | null): ConnectorRow[] {
  return (directory?.connections ?? []).map((connection) => ({
    id: connectorResourceId(connection),
    label: connectorResourceLabel(connection),
    providerId: connection.provider,
    name: connectorResourceLabel(connection),
    detail: `${connection.integrationId} · ${connection.connectionId}`,
    source: "directory",
    href: null,
    healthy: connection.errors === 0,
    problem:
      connection.errors === 0
        ? null
        : `${connection.errors} ${connection.errors === 1 ? "error" : "errors"}`,
  }));
}

function connectionRows(connections: readonly Connection[]): ConnectorRow[] {
  return connections
    .filter((connection) => connection.status !== "revoked")
    .map((connection) => ({
      // The ledger key predates Connect; kept so earlier bindings still match.
      id: `host:${connection.connectionId}`.slice(0, 128),
      label: connection.displayName.slice(0, 128),
      providerId: connection.providerId,
      name: connection.displayName,
      detail: `${connection.providerId} · ${connection.connectionRef ?? connection.connectionId}`,
      source: "connections",
      href: connectorPath(connection.providerId, connection.connectionId),
      healthy: connection.status === "active",
      problem:
        connection.status === "active"
          ? null
          : (connection.statusDetail ?? connection.status),
    }));
}

/**
 * A row for every grant no connector row carries, so access that exists is
 * always listed and can be revoked: a provider-wide grant (a standing grant,
 * keyed by provider id) with no connection of that provider here, and a grant
 * on a connector that was removed or never imported on this device.
 */
function grantOnlyRows(
  shares: readonly LocalShare[],
  rows: readonly ConnectorRow[],
): ConnectorRow[] {
  const covered = (share: LocalShare) =>
    rows.some(
      (row) =>
        row.id === share.resourceId || row.providerId === share.resourceId,
    );
  const seen = new Map<string, ConnectorRow>();
  for (const share of shares) {
    if (covered(share) || seen.has(share.resourceId)) continue;
    const removed = /[:/#]/.test(share.resourceId);
    // A standing grant's label was written when it was issued; the catalog
    // names the provider now.
    const name = removed
      ? share.resourceLabel
      : (catalogProvider(share.resourceId)?.displayName ?? share.resourceLabel);
    seen.set(share.resourceId, {
      id: share.resourceId,
      label: share.resourceLabel,
      providerId: removed ? "" : share.resourceId,
      name,
      detail: removed
        ? share.resourceId
        : `${share.resourceId} · every connection`,
      source: removed ? "removed" : "provider",
      href: removed ? null : connectorPath(share.resourceId),
      healthy: removed ? false : null,
      problem: removed ? "Removed" : null,
    });
  }
  return [...seen.values()];
}

async function readConnections(): Promise<Connection[]> {
  try {
    return await listConnections();
  } catch {
    // Connections that do not answer are not this panel's failure to report:
    // the Connections page says so, and the directory rows stand.
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

async function readAll(tomb: string): Promise<Loaded> {
  const [directory, connections, granted, identities, settings] =
    await Promise.all([
      readConnectorDirectory(tomb),
      readConnections(),
      listLocalShares(tomb),
      readIdentities(tomb),
      readConnectorSettings(tomb),
    ]);
  return {
    directory,
    connections,
    shares: granted.filter((share) => share.resourceKind === "connection"),
    identities,
    settings,
  };
}

/** The panel's reads: once on mount, on every ledger change, and on focus. */
function useConnectorReads(tomb: string) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState("");
  const alive = useRef(false);
  const generation = useRef(0);

  const reload = useCallback(async () => {
    const request = ++generation.current;
    try {
      const next = await readAll(tomb);
      if (!alive.current || request !== generation.current) return;
      setLoaded(next);
      setError("");
    } catch {
      if (!alive.current || request !== generation.current) return;
      setError("Unlock this vault and reload to read its connectors.");
    }
  }, [tomb]);

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

export function useConnectorAccess(tomb: string) {
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
    () => [...directoryRows(directory), ...connectionRows(connections)],
    [directory, connections],
  );
  // This connection's own bindings, then the provider-wide grants that
  // cover it (the standing grants, keyed by provider id).
  const bindingsFor = (row: ConnectorRow) =>
    shares.filter(
      (share) =>
        share.resourceId === row.id || share.resourceId === row.providerId,
    );

  const granted = useMemo(
    () => [
      ...rows.filter((row) =>
        shares.some(
          (share) =>
            share.resourceId === row.id || share.resourceId === row.providerId,
        ),
      ),
      ...grantOnlyRows(shares, rows),
    ],
    [rows, shares],
  );

  return {
    rows,
    granted,
    settings: reads.loaded?.settings ?? {},
    settingsFor: (row: ConnectorRow) =>
      settingFor(reads.loaded?.settings ?? {}, row.id),
    identities: reads.loaded?.identities ?? [],
    loaded: reads.loaded !== null,
    busy,
    error: reads.error,
    message,
    reload: reads.reload,
    bindingsFor,
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
    saveSetting: (row: ConnectorRow, setting: ConnectorSetting) =>
      run(async () => {
        await writeConnectorSetting(tomb, row.id, setting);
        return `${row.name} configured.`;
      }),
  };
}
