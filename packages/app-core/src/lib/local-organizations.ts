import type { OrganizationRole } from "@opensesame/os-domain";
import {
  type LocalDirectory,
  LocalDirectoryError,
  commitLocalDirectoryUnderLock,
  readLocalDirectory,
} from "./local-directory.js";
import {
  type LocalSession,
  withLocalIdentitySession,
} from "./local-sessions.js";

function unavailable(): never {
  throw new LocalDirectoryError("This organization is unavailable.");
}

function membership(
  directory: LocalDirectory,
  organizationId: string,
  principalId: string,
) {
  const org = directory.entries.find(
    (entry) =>
      entry.id === organizationId &&
      entry.kind === "organization" &&
      entry.enabled,
  );
  const member = directory.memberships.find(
    (row) =>
      row.organizationId === organizationId && row.principalId === principalId,
  );
  if (!org || !member) unavailable();
  return { org, member };
}

/** Only active organizations the authenticated local person belongs to. */
export async function listLocalOrganizations(
  tomb: string,
  session: LocalSession,
) {
  return withLocalIdentitySession(
    tomb,
    session,
    async (identity, assertActive) => {
      const directory = await readLocalDirectory(tomb);
      assertActive();
      return directory.memberships
        .filter((row) => row.principalId === identity.principalId)
        .flatMap((row) => {
          const org = directory.entries.find(
            (entry) =>
              entry.id === row.organizationId &&
              entry.kind === "organization" &&
              entry.enabled,
          );
          return org ? [{ id: org.id, name: org.name, role: row.role }] : [];
        });
    },
  );
}

export async function readLocalOrganization(
  tomb: string,
  session: LocalSession,
  organizationId: string,
) {
  return withLocalIdentitySession(
    tomb,
    session,
    async (identity, assertActive) => {
      const directory = await readLocalDirectory(tomb);
      assertActive();
      const { org, member } = membership(
        directory,
        organizationId,
        identity.principalId,
      );
      return {
        id: org.id,
        name: org.name,
        role: member.role,
        members: directory.memberships.filter(
          (row) => row.organizationId === organizationId,
        ),
      };
    },
  );
}

/** Owner: all roles. Admin: ordinary members only, never owner/admin peers. */
export async function changeLocalOrganizationMembership(
  tomb: string,
  session: LocalSession,
  organizationId: string,
  principalId: string,
  role: OrganizationRole | null,
): Promise<void> {
  return withLocalIdentitySession(
    tomb,
    session,
    async (identity, assertActive) => {
      if (identity.authentication !== "passkey") unavailable();
      const directory = await readLocalDirectory(tomb);
      assertActive();
      const { member } = membership(
        directory,
        organizationId,
        identity.principalId,
      );
      const target = directory.memberships.find(
        (row) =>
          row.organizationId === organizationId &&
          row.principalId === principalId,
      );
      if (
        member.role !== "owner" &&
        (member.role !== "admin" ||
          (role !== null && role !== "member") ||
          (target && target.role !== "member"))
      )
        unavailable();
      await commitLocalDirectoryUnderLock(tomb, directory.revision, {
        action: "membership",
        organizationId,
        principalId,
        role,
      });
    },
  );
}
