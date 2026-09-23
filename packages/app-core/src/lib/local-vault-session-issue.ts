/** Resolve session grant subjects and issue LocalShares for a vault session. */

import type { OrganizationRole } from "@opensesame/os-domain";
import { readLocalDirectory } from "./local-directory.js";
import { guestPersonIds } from "./local-guest.js";
import { type AccessRole, resolveAccessRole } from "./local-rbac.js";
import { createLocalShare } from "./local-share-grants.js";
import type {
  LocalVaultSession,
  SessionSubject,
} from "./local-vault-sessions.js";

export async function resolvePrincipals(
  tomb: string,
  subject: SessionSubject,
): Promise<string[]> {
  const directory = await readLocalDirectory(tomb);
  if (subject.kind === "principal") {
    if (!directory.entries.some((entry) => entry.id === subject.principalId))
      return [];
    return [subject.principalId];
  }
  if (subject.kind === "accessRole") {
    if (subject.role === "guest") {
      return [...guestPersonIds(directory.entries)];
    }
    return directory.entries
      .filter((entry) => entry.kind === "person" || entry.kind === "agent")
      .filter(
        (entry) => resolveAccessRole(directory, entry.id) === subject.role,
      )
      .map((entry) => entry.id);
  }
  return directory.memberships
    .filter((row) => row.role === subject.role)
    .map((row) => row.principalId);
}

function subjectMatches(
  subject: SessionSubject,
  principalId: string,
  accessRole: AccessRole | null,
  orgRole: OrganizationRole | null,
): boolean {
  if (subject.kind === "principal") return subject.principalId === principalId;
  if (subject.kind === "accessRole") return accessRole === subject.role;
  return orgRole === subject.role;
}

export async function issueSessionGrants(
  tomb: string,
  session: LocalVaultSession,
  onlyPrincipalId?: string,
): Promise<string[]> {
  const directory = await readLocalDirectory(tomb);
  const remainingMs = (session.expiresAt ?? Date.now()) - Date.now();
  const durationSeconds = Math.max(60, Math.ceil(remainingMs / 1000));
  const issued: string[] = [];
  for (const grant of session.grants) {
    const principals = onlyPrincipalId
      ? subjectMatches(
          grant.subject,
          onlyPrincipalId,
          resolveAccessRole(directory, onlyPrincipalId),
          directory.memberships.find(
            (row) => row.principalId === onlyPrincipalId,
          )?.role ?? null,
        )
        ? [onlyPrincipalId]
        : []
      : await resolvePrincipals(tomb, grant.subject);
    for (const principalId of principals) {
      const shares = await createLocalShare(
        tomb,
        {
          principalId,
          resourceKind: grant.resourceKind,
          resourceId: grant.resourceId,
          resourceLabel: grant.resourceLabel,
          policy: grant.policy,
          durationSeconds,
          sessionId: session.id,
        },
        { bypassAccessCheck: true },
      );
      const created = shares.find(
        (row) =>
          row.sessionId === session.id &&
          row.principalId === principalId &&
          row.resourceKind === grant.resourceKind &&
          row.resourceId === grant.resourceId &&
          row.policy === grant.policy,
      );
      if (created) issued.push(created.id);
    }
  }
  return issued;
}
