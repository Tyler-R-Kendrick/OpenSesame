/**
 * Default owner person, organization, OpenSesame agent, and this app.
 *
 * The organization owns this instance's projects/vaults. The OpenSesame
 * agent is the in-product helper (ADR 0088); it is a member, never an owner.
 * The OpenSesame application is this origin as a relying party, so grants
 * and policies apply to Pages itself. A guest person is always present
 * (`guest@guest`) so Access can grant and tighten what guests may use.
 */

export const SUPPORT_AGENT_ID = "local_00000000-0000-4000-8000-000000000001";
export const SUPPORT_AGENT_NAME = "open-sesame";
export const PAGES_APPLICATION_ID =
  "local_00000000-0000-4000-8000-000000000002";
export const PAGES_APPLICATION_NAME = "OpenSesame";
export {
  GUEST_PERSON_ID,
  GUEST_PERSON_NAME,
} from "./local-guest.js";
import { GUEST_PERSON_ID, GUEST_PERSON_NAME } from "./local-guest.js";

import { describeAccount } from "./account.js";
import {
  type LocalDirectory,
  commitLocalDirectoryUnderLock,
  readLocalDirectory,
  withLocalDirectoryLock,
} from "./local-directory.js";
import { vaultStore } from "./vault/store.js";

function isPlaceholderPerson(name: string): boolean {
  const trimmed = name.trim();
  return (
    trimmed === "Owner" ||
    trimmed.toLowerCase() === "guest" ||
    trimmed === GUEST_PERSON_NAME
  );
}

function orgNameFor(personName: string): string {
  const name = personName.trim();
  if (!name || isPlaceholderPerson(name)) return "Personal";
  return name.length <= 128 ? name : "Personal";
}

/** Person name for the signed-in identity — guest prompt or account name. */
export function ownerPersonName(
  guest: boolean,
  accountName?: string | null,
  accountGuest = false,
): string {
  if (guest || accountGuest) return GUEST_PERSON_NAME;
  const name = accountName?.trim();
  return name || "Owner";
}

export function currentOwnerPersonName(): string {
  const account = describeAccount();
  return ownerPersonName(
    vaultStore.getSnapshot().guest,
    account?.name,
    account?.guest,
  );
}

function findGuestPerson(
  directory: LocalDirectory,
): LocalDirectory["entries"][number] | undefined {
  return (
    directory.entries.find((entry) => entry.id === GUEST_PERSON_ID) ??
    directory.entries.find(
      (entry) => entry.kind === "person" && entry.name === GUEST_PERSON_NAME,
    )
  );
}

async function ensurePerson(
  tomb: string,
  current: LocalDirectory,
  label: string,
): Promise<LocalDirectory> {
  const name = label.length <= 128 ? label : "Owner";
  if (!current.entries.some((entry) => entry.kind === "person")) {
    if (name === GUEST_PERSON_NAME) {
      return commitLocalDirectoryUnderLock(tomb, current.revision, {
        action: "create",
        kind: "person",
        name,
        id: GUEST_PERSON_ID,
      });
    }
    return commitLocalDirectoryUnderLock(tomb, current.revision, {
      action: "create",
      kind: "person",
      name,
    });
  }
  const person = current.entries.find((entry) => entry.kind === "person");
  if (person && isPlaceholderPerson(person.name) && person.name !== name) {
    // Guest is a standing principal; never rename Owner into a second guest@guest.
    if (
      name === GUEST_PERSON_NAME &&
      findGuestPerson(current)?.id !== person.id
    ) {
      return current;
    }
    return commitLocalDirectoryUnderLock(tomb, current.revision, {
      action: "update",
      id: person.id,
      name,
      enabled: person.enabled,
    });
  }
  return current;
}

/** Guest is always a directory principal so Access can grant them policies. */
async function ensureGuestPerson(
  tomb: string,
  current: LocalDirectory,
): Promise<LocalDirectory> {
  if (findGuestPerson(current)) return current;
  return commitLocalDirectoryUnderLock(tomb, current.revision, {
    action: "create",
    kind: "person",
    name: GUEST_PERSON_NAME,
    id: GUEST_PERSON_ID,
  });
}

async function ensureAgent(
  tomb: string,
  current: LocalDirectory,
): Promise<LocalDirectory> {
  const existing = current.entries.find(
    (entry) => entry.id === SUPPORT_AGENT_ID,
  );
  if (!existing) {
    return commitLocalDirectoryUnderLock(tomb, current.revision, {
      action: "create",
      kind: "agent",
      name: SUPPORT_AGENT_NAME,
      id: SUPPORT_AGENT_ID,
    });
  }
  if (existing.kind === "agent" && existing.name === "Support") {
    return commitLocalDirectoryUnderLock(tomb, current.revision, {
      action: "update",
      id: existing.id,
      name: SUPPORT_AGENT_NAME,
      enabled: existing.enabled,
    });
  }
  return current;
}

async function ensurePagesApplication(
  tomb: string,
  current: LocalDirectory,
): Promise<LocalDirectory> {
  const existing = current.entries.find(
    (entry) => entry.id === PAGES_APPLICATION_ID,
  );
  if (!existing) {
    return commitLocalDirectoryUnderLock(tomb, current.revision, {
      action: "create",
      kind: "application",
      name: PAGES_APPLICATION_NAME,
      id: PAGES_APPLICATION_ID,
    });
  }
  return current;
}

export async function ensureOwnerPerson(
  tomb: string,
  name = "Owner",
): Promise<LocalDirectory> {
  const label = name.trim() || "Owner";
  const directory = await withLocalDirectoryLock(tomb, async () => {
    let current = await ensurePerson(
      tomb,
      await readLocalDirectory(tomb),
      label,
    );
    current = await ensureGuestPerson(tomb, current);
    const person = current.entries.find((entry) => entry.kind === "person");
    if (!person) return current;
    if (!current.entries.some((entry) => entry.kind === "organization")) {
      current = await commitLocalDirectoryUnderLock(tomb, current.revision, {
        action: "create",
        kind: "organization",
        name: orgNameFor(person.name),
      });
    }
    const org = current.entries.find((entry) => entry.kind === "organization");
    if (
      org &&
      !current.memberships.some(
        (row) => row.organizationId === org.id && row.principalId === person.id,
      )
    ) {
      current = await commitLocalDirectoryUnderLock(tomb, current.revision, {
        action: "membership",
        organizationId: org.id,
        principalId: person.id,
        role: "owner",
      });
    }
    const guest = findGuestPerson(current);
    if (
      org &&
      guest &&
      guest.id !== person.id &&
      !current.memberships.some(
        (row) => row.organizationId === org.id && row.principalId === guest.id,
      )
    ) {
      current = await commitLocalDirectoryUnderLock(tomb, current.revision, {
        action: "membership",
        organizationId: org.id,
        principalId: guest.id,
        role: "member",
      });
    }
    current = await ensureAgent(tomb, current);
    if (
      org &&
      !current.memberships.some(
        (row) =>
          row.organizationId === org.id && row.principalId === SUPPORT_AGENT_ID,
      )
    ) {
      current = await commitLocalDirectoryUnderLock(tomb, current.revision, {
        action: "membership",
        organizationId: org.id,
        principalId: SUPPORT_AGENT_ID,
        role: "member",
      });
    }
    return ensurePagesApplication(tomb, current);
  });
  const org = directory.entries.find((entry) => entry.kind === "organization");
  const app = directory.entries.find(
    (entry) => entry.id === PAGES_APPLICATION_ID && entry.enabled,
  );
  if (org && app) {
    const { ensurePagesApplicationRegistration } = await import(
      "./local-applications.js"
    );
    await ensurePagesApplicationRegistration(tomb, app.id, org.id);
  }
  return directory;
}
