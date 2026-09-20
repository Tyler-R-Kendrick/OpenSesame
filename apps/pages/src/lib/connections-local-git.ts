import type { Connection } from "./connections.js";
import {
  type LocalGitRemote,
  forgetLocalGitRemote,
  isLocalGitRemoteId,
  listLocalGitRemotes,
} from "./git-remote-local.js";

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
  await forgetLocalGitRemote(id);
  return { revoked: true, providerRevocation: "ok" };
}
