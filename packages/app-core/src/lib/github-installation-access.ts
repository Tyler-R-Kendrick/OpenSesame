/**
 * GitHub App installation snapshot for the connector page: who the install
 * is, which repos it can see, and the Access grant that may use it.
 */

import type { JsonObject } from "@opensesame/os-domain";
import { type GithubInstallation, listGithubInstallations } from "./backup.js";
import {
  type Connection,
  type ConnectionEvent,
  type Integration,
  bindConnection,
  connectionEvents,
  listConnections,
  listIntegrations,
  unbindConnection,
} from "./connections.js";
import { type GithubRepoSummary, listGithubRepos } from "./github-history.js";
import { isGuestSession, isGuestTomb } from "./guest-isolation.js";
import {
  type LocalAccessAuditEvent,
  listAccessAuditEvents,
  recordAccessAuditEvent,
  sanitizeConnectionEvents,
} from "./local-access-audit.js";
import { readLocalDirectory } from "./local-directory.js";
import {
  type LocalShare,
  ensureLocalShare,
  listLocalShares,
  revokeLocalShare,
} from "./local-share-grants.js";

export const GITHUB_PROVIDER_ID = "github";
export const GITHUB_ACCESS_POLICY = "invoke";

export type GithubInstallationSnapshot = {
  integrations: Integration[];
  installations: GithubInstallation[];
  repos: GithubRepoSummary[];
  shares: LocalShare[];
  /** Host connection events with free-text detail scrubbed (no SII/PII). */
  events: ConnectionEvent[];
  /** Sealed Access audit trail — allowlisted metadata only (ADR 0015). */
  auditEvents: LocalAccessAuditEvent[];
};

function githubIntegrations(rows: Integration[]): Integration[] {
  return rows.filter(
    (row) =>
      row.providerId === GITHUB_PROVIDER_ID &&
      row.enabled &&
      row.configured &&
      (row.source === "organization" || row.source === "github-app"),
  );
}

function githubShares(shares: LocalShare[]): LocalShare[] {
  return shares.filter(
    (share) =>
      share.resourceKind === "connection" &&
      share.resourceId === GITHUB_PROVIDER_ID,
  );
}

async function ownerPersonId(tomb: string): Promise<{
  id: string;
  name: string;
} | null> {
  const directory = await readLocalDirectory(tomb);
  const owner = directory.entries.find(
    (entry) => entry.kind === "person" && entry.enabled,
  );
  if (!owner) return null;
  return { id: owner.id, name: owner.name };
}

const EMPTY_SNAPSHOT: GithubInstallationSnapshot = {
  integrations: [],
  installations: [],
  repos: [],
  shares: [],
  events: [],
  auditEvents: [],
};

/** Load install identity, repos (when a connection is active), Access grants, events. */
export async function loadGithubInstallationSnapshot(
  tomb: string,
  connection: Connection | null,
): Promise<GithubInstallationSnapshot> {
  // Guests never read Host installs — even in GUEST_TOMB (guest-isolation).
  if (isGuestSession()) return EMPTY_SNAPSHOT;
  const integrations = githubIntegrations(
    await listIntegrations().catch(() => []),
  );
  const installations: GithubInstallation[] = [];
  for (const integration of integrations) {
    const rows = await listGithubInstallations(integration.id).catch(() => []);
    installations.push(...rows);
  }
  const repos =
    connection?.status === "active"
      ? await listGithubRepos(connection.connectionId).catch(() => [])
      : [];
  const shares = githubShares(await listLocalShares(tomb));
  const events =
    connection !== null
      ? sanitizeConnectionEvents(
          await connectionEvents(connection.connectionId).catch(() => []),
        )
      : [];
  const auditEvents = await listAccessAuditEvents(tomb).catch(() => []);
  return { integrations, installations, repos, shares, events, auditEvents };
}

/**
 * Standing Access grant so the vault owner may invoke GitHub, plus a Host
 * binding when a live connection exists (records a `bound` connection event).
 */
export async function ensureGithubAccessGrant(
  tomb: string,
  connection: Connection | null,
): Promise<LocalShare[]> {
  if (isGuestSession()) {
    throw new Error(
      "Guests cannot record member GitHub Access grants. Continue in a member vault, or end the guest session.",
    );
  }
  const owner = await ownerPersonId(tomb);
  if (!owner) return githubShares(await listLocalShares(tomb));
  const before = githubShares(await listLocalShares(tomb));
  const hadGrant = before.length > 0;
  await ensureLocalShare(tomb, {
    principalId: owner.id,
    resourceKind: "connection",
    resourceId: GITHUB_PROVIDER_ID,
    resourceLabel: "GitHub",
    policy: GITHUB_ACCESS_POLICY,
  });
  // Renewals rewrite the share id — only the first standing grant is an event.
  if (!hadGrant) {
    const grantMetadata: JsonObject = {
      providerId: GITHUB_PROVIDER_ID,
      resourceType: "connection",
      resourceId: GITHUB_PROVIDER_ID,
      action: "grant",
      kind: "share",
    };
    if (connection) grantMetadata.connectionId = connection.connectionId;
    await recordAccessAuditEvent(tomb, {
      eventType: "access.connection.granted",
      outcome: "succeeded",
      targetType: "connection",
      targetId: GITHUB_PROVIDER_ID,
      metadata: grantMetadata,
    });
  }
  if (connection?.status === "active") {
    const already = connection.bindings.some(
      (binding) =>
        binding.targetKind === "identity" && binding.targetId === owner.id,
    );
    if (!already) {
      await bindConnection(connection.connectionId, {
        targetKind: "identity",
        targetId: owner.id,
        targetLabel: owner.name,
      })
        .then(async () => {
          await recordAccessAuditEvent(tomb, {
            eventType: "connection.binding.bound",
            outcome: "succeeded",
            targetType: "connection",
            targetId: GITHUB_PROVIDER_ID,
            metadata: {
              providerId: GITHUB_PROVIDER_ID,
              connectionId: connection.connectionId,
              subjectKind: "identity",
              action: "bind",
              kind: "binding",
            },
          });
        })
        .catch(() => undefined);
    }
  }
  return githubShares(await listLocalShares(tomb));
}

/** True when the connector page should mint the standing Access grant. */
export function shouldEnsureGithubAccessGrant(
  snapshot: GithubInstallationSnapshot,
  connection: Connection | null,
): boolean {
  if (snapshot.shares.length > 0) return false;
  const last = snapshot.events.find(
    (event) => event.kind === "bound" || event.kind === "unbound",
  );
  if (last?.kind === "unbound") return false;
  return (
    connection?.status === "active" ||
    snapshot.integrations.length > 0 ||
    snapshot.installations.length > 0
  );
}

/** Revoke the Access grant and any matching Host identity binding. */
export async function revokeGithubAccessGrant(
  tomb: string,
  shareId: string,
  connection: Connection | null,
): Promise<LocalShare[]> {
  if (isGuestSession() && !isGuestTomb(tomb)) {
    throw new Error(
      "Guests cannot revoke member GitHub Access grants. Continue in a member vault, or end the guest session.",
    );
  }
  const before = (await listLocalShares(tomb)).find(
    (share) => share.id === shareId,
  );
  await revokeLocalShare(tomb, shareId);
  if (before) {
    const revokeMetadata: JsonObject = {
      providerId: GITHUB_PROVIDER_ID,
      resourceType: "connection",
      resourceId: GITHUB_PROVIDER_ID,
      action: "revoke",
      kind: "share",
    };
    if (connection) revokeMetadata.connectionId = connection.connectionId;
    await recordAccessAuditEvent(tomb, {
      eventType: "access.connection.revoked",
      outcome: "succeeded",
      targetType: "connection",
      targetId: GITHUB_PROVIDER_ID,
      metadata: revokeMetadata,
    });
  }
  if (connection && before) {
    const live =
      (await listConnections().catch(() => [])).find(
        (row) => row.connectionId === connection.connectionId,
      ) ?? connection;
    const binding = live.bindings.find(
      (row) =>
        row.targetKind === "identity" && row.targetId === before.principalId,
    );
    if (binding) {
      await unbindConnection(live.connectionId, binding.id)
        .then(async () => {
          await recordAccessAuditEvent(tomb, {
            eventType: "connection.binding.unbound",
            outcome: "succeeded",
            targetType: "connection",
            targetId: GITHUB_PROVIDER_ID,
            metadata: {
              providerId: GITHUB_PROVIDER_ID,
              connectionId: live.connectionId,
              subjectKind: "identity",
              action: "unbind",
              kind: "binding",
            },
          });
        })
        .catch(() => undefined);
    }
  }
  return githubShares(await listLocalShares(tomb));
}
