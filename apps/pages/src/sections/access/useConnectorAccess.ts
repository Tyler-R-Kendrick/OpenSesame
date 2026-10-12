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
 * subset someone holds access to, or a grant waiting for approval — what
 * the panel lists. An agent grant stays pending until it is approved.
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
  type PendingShare,
  approvePendingShare,
  denyPendingShare,
  listPendingShares,
  submitLocalShare,
} from "@opensesame/app-core/lib/local-share-grants-approvals.js";
import {
  type GrantIdentity,
  type LocalShare,
  grantIdentities,
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
      provider here, or a grant on a connector this device does not list. */
  source: "directory" | "connections" | "provider" | "unlisted";
  /** The connector's own page on Connections, for a Connections row. */
  href: string | null;
  /** Null where there is no connection whose health could be read. */
  healthy: boolean | null;
  /** What is wrong, when something is. */
  problem: string | null;
}>;

export type ConnectorIdentity = GrantIdentity;

export type BindInput = {
  principalId: string;
  policy: string;
  durationSeconds: number;
};

type Loaded = {
  directory: ConnectorDirectory | null;
  /** Null when the Connections list could not be read. */
  connections: Connection[] | null;
  shares: LocalShare[];
  pending: PendingShare[];
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
 * always listed and can be revoked or approved: a provider-wide grant (a
 * standing grant, keyed by provider id) with no connection of that provider
 * here, and a grant on a connector this device does not list — removed,
 * never imported, or on a Connections list that did not answer
 * (`connectionsRead` false), which is why such a row then reports no health
 * rather than claiming it is gone. A pending approval is held the same way.
 */
function grantOnlyRows(
  shares: readonly { resourceId: string; resourceLabel: string }[],
  rows: readonly ConnectorRow[],
  connectionsRead: boolean,
): ConnectorRow[] {
  const covered = (resourceId: string) =>
    rows.some((row) => row.id === resourceId || row.providerId === resourceId);
  const seen = new Map<string, ConnectorRow>();
  for (const share of shares) {
    if (covered(share.resourceId) || seen.has(share.resourceId)) continue;
    const unlisted = /[:/#]/.test(share.resourceId);
    if (!unlisted) {
      seen.set(share.resourceId, {
        id: share.resourceId,
        label: share.resourceLabel,
        providerId: share.resourceId,
        // A standing grant's label was written when it was issued; the
        // catalog names the provider now.
        name:
          catalogProvider(share.resourceId)?.displayName ?? share.resourceLabel,
        detail: `${share.resourceId} · every connection`,
        source: "provider",
        href: connectorPath(share.resourceId),
        healthy: null,
        problem: null,
      });
      continue;
    }
    const known = connectionsRead || !share.resourceId.startsWith("host:");
    seen.set(share.resourceId, {
      id: share.resourceId,
      label: share.resourceLabel,
      providerId: "",
      name: share.resourceLabel,
      detail: share.resourceId,
      source: "unlisted",
      href: null,
      healthy: known ? false : null,
      problem: known ? "Not configured" : null,
    });
  }
  return [...seen.values()];
}

async function readConnections(): Promise<Connection[] | null> {
  try {
    return await listConnections();
  } catch {
    // Connections that do not answer are not this panel's failure to report:
    // the Connections page says so, and the directory rows stand.
    return null;
  }
}

async function readIdentities(tomb: string): Promise<ConnectorIdentity[]> {
  const directory = await readLocalDirectory(tomb);
  return grantIdentities(directory.entries);
}

async function readApprovals(tomb: string): Promise<PendingShare[]> {
  try {
    return await listPendingShares(tomb);
  } catch {
    // A damaged approval file must not hide the grants that are already active.
    return [];
  }
}

async function readAll(tomb: string): Promise<Loaded> {
  const [directory, connections, granted, pending, identities, settings] =
    await Promise.all([
      readConnectorDirectory(tomb),
      readConnections(),
      listLocalShares(tomb),
      readApprovals(tomb),
      readIdentities(tomb),
      readConnectorSettings(tomb),
    ]);
  return {
    directory,
    connections,
    shares: granted.filter((share) => share.resourceKind === "connection"),
    pending: pending.filter((row) => row.resourceKind === "connection"),
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
  const pending = reads.loaded?.pending ?? [];
  const connections = reads.loaded?.connections ?? [];
  const connectionsRead = reads.loaded?.connections !== null;
  const settings = reads.loaded?.settings ?? {};

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
  const onRow = (row: ConnectorRow, resourceId: string) =>
    resourceId === row.id || resourceId === row.providerId;
  const bindingsFor = (row: ConnectorRow) =>
    shares.filter((share) => onRow(row, share.resourceId));
  const pendingFor = (row: ConnectorRow) =>
    pending.filter((share) => onRow(row, share.resourceId));

  // A disabled connector stays listed with nobody bound: switching it off
  // is an access decision too, and its row is where it is switched back on.
  // A pending approval is listed too, so it can be approved on this row.
  const granted = useMemo(
    () => [
      ...rows.filter(
        (row) =>
          !settingFor(settings, row.id).enabled ||
          shares.some(
            (share) =>
              share.resourceId === row.id ||
              share.resourceId === row.providerId,
          ) ||
          pending.some(
            (share) =>
              share.resourceId === row.id ||
              share.resourceId === row.providerId,
          ),
      ),
      ...grantOnlyRows([...shares, ...pending], rows, connectionsRead),
    ],
    [rows, shares, pending, settings, connectionsRead],
  );

  return {
    rows,
    granted,
    settings,
    settingsFor: (row: ConnectorRow) => settingFor(settings, row.id),
    identities: reads.loaded?.identities ?? [],
    loaded: reads.loaded !== null,
    busy,
    error: reads.error,
    message,
    reload: reads.reload,
    bindingsFor,
    pendingFor,
    ...connectorMutations(tomb, run),
  };
}

function connectorMutations(
  tomb: string,
  run: (action: () => Promise<string>) => Promise<boolean>,
) {
  return {
    bind: (row: ConnectorRow, input: BindInput) =>
      run(async () => {
        const submitted = await submitLocalShare(tomb, {
          principalId: input.principalId,
          resourceKind: "connection",
          resourceId: row.id,
          resourceLabel: row.label,
          policy: input.policy,
          durationSeconds: input.durationSeconds,
        });
        return submitted.outcome === "pending"
          ? "Approval requested."
          : `${row.name} bound.`;
      }),
    approve: (id: string) =>
      run(async () => {
        await approvePendingShare(tomb, id);
        return "Grant approved.";
      }),
    deny: (id: string) =>
      run(async () => {
        await denyPendingShare(tomb, id);
        return "Grant denied.";
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
