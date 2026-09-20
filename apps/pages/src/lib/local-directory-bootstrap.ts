/**
 * Default owner person, organization, OpenSesame agent, and this app.
 *
 * The organization owns this instance's projects/vaults. The OpenSesame
 * agent is the in-product helper (ADR 0088); it is a member, never an owner.
 * The OpenSesame application is this origin as a relying party, so grants
 * and policies apply to Pages itself.
 *
 * Guest principals are per-session unclaimed people (`Guest N`), minted only
 * into the active guest tomb — never a standing singleton on personal vaults.
 */

export const SUPPORT_AGENT_ID = "local_00000000-0000-4000-8000-000000000001";
export const SUPPORT_AGENT_NAME = "open-sesame";
export const PAGES_APPLICATION_ID =
  "local_00000000-0000-4000-8000-000000000002";
export const PAGES_APPLICATION_NAME = "OpenSesame";
export {
  GUEST_PERSON_ID,
  GUEST_PERSON_NAME,
  guestSessionPerson,
  isGuestDisplayName,
  mintGuestSessionPerson,
} from "./local-guest.js";
import {
  guestSessionPerson,
  isGuestDisplayName,
  isGuestPersonEntry,
  readGuestSessionPerson,
} from "./local-guest.js";

import { describeAccount } from "./account.js";
import {
  type LocalDirectory,
  commitLocalDirectoryUnderLock,
  readLocalDirectory,
  withLocalDirectoryLock,
} from "./local-directory.js";
import { vaultStore } from "./vault/store.js";
import { GUEST_TOMB } from "./vfs.js";

function isPlaceholderPerson(name: string): boolean {
  const trimmed = name.trim();
  return trimmed === "Owner" || isGuestDisplayName(trimmed);
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
  if (guest || accountGuest) {
    return readGuestSessionPerson()?.name ?? "guest";
  }
  const name = accountName?.trim();
  return name || "Owner";
}

export function currentOwnerPersonName(): string {
  const account = describeAccount();
  const snap = vaultStore.getSnapshot();
  // Guest tomb is always the guest road — even before unlock marks ephemeral.
  const guestRoad = snap.guest || snap.tomb === GUEST_TOMB;
  return ownerPersonName(guestRoad, account?.name, account?.guest);
}

function findGuestPerson(
  directory: LocalDirectory,
): LocalDirectory["entries"][number] | undefined {
  const session = readGuestSessionPerson();
  if (session) {
    const match = directory.entries.find((entry) => entry.id === session.id);
    if (match) return match;
  }
  return directory.entries.find((entry) => isGuestPersonEntry(entry));
}

function guestSessionActive(tomb: string): boolean {
  return tomb === GUEST_TOMB || vaultStore.getSnapshot().guest;
}

async function ensurePerson(
  tomb: string,
  current: LocalDirectory,
  label: string,
): Promise<LocalDirectory> {
  const name = label.length <= 128 ? label : "Owner";
  if (!current.entries.some((entry) => entry.kind === "person")) {
    if (isGuestDisplayName(name) && guestSessionActive(tomb)) {
      const guest = guestSessionPerson();
      return commitLocalDirectoryUnderLock(tomb, current.revision, {
        action: "create",
        kind: "person",
        name: guest.name,
        id: guest.id,
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
    // Never rename a claimed/owner person into a guest label, and never
    // overwrite a different guest principal with this session's name.
    if (
      isGuestDisplayName(name) &&
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

/**
 * On the guest tomb only: ensure THIS session's guest principal exists.
 * Personal vaults do not get a standing guest person — that singleton made
 * every guest share one account for connectors and grants.
 */
async function ensureGuestPerson(
  tomb: string,
  current: LocalDirectory,
): Promise<LocalDirectory> {
  if (!guestSessionActive(tomb)) return current;
  if (findGuestPerson(current)) return current;
  const guest = guestSessionPerson();
  return commitLocalDirectoryUnderLock(tomb, current.revision, {
    action: "create",
    kind: "person",
    name: guest.name,
    id: guest.id,
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
