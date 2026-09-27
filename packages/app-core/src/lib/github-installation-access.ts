/**
 * GitHub App installation snapshot for the connector page: who the install
 * is, which repos it can see, and the Access grant that may use it.
 *
 * The grant is a local share of kind `connection` and nothing else — the one
 * ledger Access reads and revokes (ADR 0115). Pages writes no Host binding
 * (ADR 0128).
 */

import type { JsonObject } from "@opensesame/os-domain";
import { type GithubInstallation, listGithubInstallations } from "./backup.js";
import {
  type Connection,
  type Integration,
  listIntegrations,
} from "./connections.js";
import { type GithubRepoSummary, listGithubRepos } from "./github-history.js";
import { isGuestSession } from "./guest-isolation.js";
import {
  type LocalAccessAuditEvent,
  listAccessAuditEvents,
  recordAccessAuditEvent,
} from "./local-access-audit.js";
import { readLocalDirectory } from "./local-directory.js";
import {
  type LocalShare,
  ensureLocalShare,
  listLocalShares,
} from "./local-share-grants.js";

export const GITHUB_PROVIDER_ID = "github";
export const GITHUB_ACCESS_POLICY = "invoke";

export type GithubInstallationSnapshot = {
  integrations: Integration[];
  installations: GithubInstallation[];
  repos: GithubRepoSummary[];
  shares: LocalShare[];
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
  auditEvents: [],
};

/** Load install identity, repos (when a connection is active), Access grants and their audit trail. */
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
  const auditEvents = await listAccessAuditEvents(tomb).catch(() => []);
  return { integrations, installations, repos, shares, auditEvents };
}

/**
 * Standing Access grant so the vault owner may invoke GitHub: one local share
 * of kind `connection`, audited the first time it is issued. Revoking it is
 * Access's ordinary share revocation (`revokeLocalShare`).
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
      subject: owner.id,
      policy: GITHUB_ACCESS_POLICY,
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
  return githubShares(await listLocalShares(tomb));
}

/** True when the connector page should mint the standing Access grant. */
export function shouldEnsureGithubAccessGrant(
  snapshot: GithubInstallationSnapshot,
  connection: Connection | null,
): boolean {
  if (snapshot.shares.length > 0) return false;
  // A person who revoked the grant in Access decided; the card does not
  // re-issue it behind their back. The trail is newest first.
  const last = snapshot.auditEvents.find(
    (event) =>
      event.targetType === "connection" &&
      event.targetId === GITHUB_PROVIDER_ID &&
      (event.eventType === "access.connection.granted" ||
        event.eventType === "access.connection.revoked"),
  );
  if (last?.eventType === "access.connection.revoked") return false;
  return (
    connection?.status === "active" ||
    snapshot.integrations.length > 0 ||
    snapshot.installations.length > 0
  );
}
