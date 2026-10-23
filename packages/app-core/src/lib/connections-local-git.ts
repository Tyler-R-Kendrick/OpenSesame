import type { Connection } from "./connections.js";
import { revokeDeviceConnection } from "./device-connectors.js";
import {
  type LocalGitRemote,
  forgetLocalGitRemote,
  isLocalGitRemoteId,
  listLocalGitRemotes,
} from "./git-remote-local.js";
import { unbindHistoryConnection } from "./history-backups.js";

function gitEgress(remoteUrl: string): Connection["egress"] {
  const trimmed = remoteUrl.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      return {
        scheme: url.protocol === "http:" ? "http" : "https",
        authorities: url.host ? [url.host] : [],
        pathPrefixes: [],
      };
    } catch {
      return { scheme: "https", authorities: [], pathPrefixes: [] };
    }
  }
  if (/^ssh:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      return {
        scheme: "ssh",
        authorities: url.host ? [url.host] : [],
        pathPrefixes: [],
      };
    } catch {
      return { scheme: "ssh", authorities: [], pathPrefixes: [] };
    }
  }
  const scp = /^git@([^:]+):/.exec(trimmed);
  return {
    scheme: "ssh",
    authorities: scp?.[1] ? [scp[1]] : [],
    pathPrefixes: [],
  };
}

export function localGitToConnection(remote: LocalGitRemote): Connection {
  return {
    connectionId: remote.id,
    connectionRef: `local/git/${remote.id}`,
    logicalName: remote.id,
    displayName: remote.displayName,
    providerId: "git",
    integrationId: null,
    status: "active",
    statusDetail: null,
    organizationId: "local",
    projectId: null,
    ownerKind: "user",
    shareability: "private",
    requestedScopes: [],
    grantedScopes: [],
    accountLabel: remote.remoteUrl,
    expiresAt: null,
    refreshable: false,
    lastRefreshedAt: null,
    maxInvokeLevel: 0,
    egress: gitEgress(remote.remoteUrl),
    bindings: [],
    createdAt: remote.createdAt,
    updatedAt: remote.updatedAt,
  };
}

export function listLocalGitConnections(): Connection[] {
  return listLocalGitRemotes().map(localGitToConnection);
}

export function mergeLocalGitConnections(rows: Connection[]): Connection[] {
  const local = listLocalGitConnections();
  if (local.length === 0) return rows;
  const seen = new Set(rows.map((row) => row.connectionId));
  const extra = local.filter((row) => !seen.has(row.connectionId));
  return extra.length === 0 ? rows : [...rows, ...extra];
}

export async function revokeLocalGitConnection(id: string): Promise<{
  revoked: boolean;
  providerRevocation: "ok" | "unsupported" | "failed";
} | null> {
  if (!isLocalGitRemoteId(id)) return null;
  const removed = await forgetLocalGitRemote(id);
  if (!removed) return null;
  // Saving a forge remote also mirrors its credential into the device store
  // and binds a backup target. Revocation is not complete until those copies
  // and the binding are gone.
  await revokeDeviceConnection(id);
  unbindHistoryConnection(id);
  return { revoked: true, providerRevocation: "unsupported" };
}
