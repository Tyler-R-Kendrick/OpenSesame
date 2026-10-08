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
import { isGuestSession } from "./guest-isolation.js";
import {
  type LocalAccessAuditEvent,
  listAccessAuditEvents,
  recordAccessAuditEvent,
} from "./local-access-audit.js";
import { readLocalDirectory } from "./local-directory.js";
import { ensureLocalShare } from "./local-share-grants-approvals.js";
import { type LocalShare, listLocalShares } from "./local-share-grants.js";
import { standingConnectionRevoked } from "./standing-connection-grants.js";

export const GITHUB_PROVIDER_ID = "github";
export const GITHUB_ACCESS_POLICY = "invoke";

export type GithubInstallationSnapshot = {
  integrations: Integration[];
  installations: GithubInstallation[];
  shares: LocalShare[];
  /** The vault owner the standing grant is for; null when there is none. */
  ownerId: string | null;
  /** Sealed Access audit trail — allowlisted metadata only (ADR 0015). */
  auditEvents: LocalAccessAuditEvent[];
  /**
   * False when the trail could not be read. Whether a person revoked the
   * standing grant is then unknown, and unknown is answered as revoked.
   */
  auditReadable: boolean;
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

/** The owner's standing grant among GitHub's shares — others' shares are not it. */
function ownerGrant(
  shares: readonly LocalShare[],
  ownerId: string,
): LocalShare | undefined {
  return shares.find(
    (share) =>
      share.principalId === ownerId && share.policy === GITHUB_ACCESS_POLICY,
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

/** What a guest, or a vault with nothing of GitHub's, loads. */
export const EMPTY_GITHUB_SNAPSHOT: GithubInstallationSnapshot = {
  integrations: [],
  installations: [],
  shares: [],
  ownerId: null,
  auditEvents: [],
  auditReadable: true,
};

/** Load install identity, Access grants and their audit trail. */
export async function loadGithubInstallationSnapshot(
  tomb: string,
  connection: Connection | null,
): Promise<GithubInstallationSnapshot> {
  // Guests never read Host installs — even in GUEST_TOMB (guest-isolation).
  if (isGuestSession()) return { ...EMPTY_GITHUB_SNAPSHOT };
  const integrations = githubIntegrations(
    await listIntegrations().catch(() => []),
  );
  const installations: GithubInstallation[] = [];
  for (const integration of integrations) {
    const rows = await listGithubInstallations(integration.id).catch(() => []);
    installations.push(...rows);
  }
  const shares = githubShares(await listLocalShares(tomb));
  const owner = await ownerPersonId(tomb);
  const trail = await listAccessAuditEvents(tomb).then(
    (events) => ({ events, readable: true }),
    () => ({ events: [], readable: false }),
  );
  return {
    integrations,
    installations,
    shares,
    ownerId: owner?.id ?? null,
    auditEvents: trail.events,
    auditReadable: trail.readable,
  };
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
  const hadGrant = ownerGrant(before, owner.id) !== undefined;
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
  const { ownerId } = snapshot;
  if (ownerId === null || ownerGrant(snapshot.shares, ownerId)) return false;
  // A trail that cannot be read cannot say a person did not revoke the grant:
  // a card that issued it anyway would undo their decision behind their back.
  if (!snapshot.auditReadable) return false;
  // A person who revoked the owner's grant in Access decided; the card does
  // not re-issue it behind their back. Someone else's revocation — the support
  // agent's, another policy's — is not that decision (ADR 0147 §5).
  const revoked = standingConnectionRevoked(snapshot.auditEvents, {
    resourceId: GITHUB_PROVIDER_ID,
    principalId: ownerId,
    policy: GITHUB_ACCESS_POLICY,
  });
  if (revoked) return false;
  return (
    connection?.status === "active" ||
    snapshot.integrations.length > 0 ||
    snapshot.installations.length > 0
  );
}
