/**
 * A live-session joiner becomes a local identity, and the scope the owner
 * showed is written as standing shares for that identity (ADR 0150, ADR 0187
 * audience rules).
 *
 * This is session code, not a person's grant form: the host is open and the
 * session already passed its own policy check. It writes the identity and the
 * shares the session names, never more. A share is what lets the same person
 * reach an item outside the live catalog.
 */

import { name } from "@gdp-ts/core";
import type { VaultItem } from "@opensesame/vault-core";
import {
  type LocalDirectory,
  LocalDirectoryError,
  type LocalIdentity,
  commitLocalDirectoryUnderLock,
  readLocalDirectory,
  withLocalDirectoryLock,
} from "../local-directory.js";
import { ALL_USERS_GROUP_ID } from "../local-groups.js";
import { createLocalShareAs } from "../local-share-grants.js";
import { systemShareWrite } from "../proofs/share-write.js";
import { vaultStore } from "../vault/store.js";
import type { SharePolicy } from "./messages.js";
import type { ShareScope } from "./vault-share.js";

export type SessionAudience = "anyone" | "all-users" | "people";

export type SessionGuest = Readonly<{
  key: string;
  name: string;
  note: string;
  kind: "person" | "device";
}>;

export const sessionProvisionSeams = {
  vaultStatus: (): string => vaultStore.getSnapshot().status,
  activeTomb: (): string => vaultStore.activeTomb(),
};

export type ProvisionInput = Readonly<{
  tomb: string;
  hostId: string;
  guest: SessionGuest;
  scope: ShareScope;
  policy: SharePolicy;
  minutes: number;
  audience: SessionAudience;
  peopleIds: readonly string[];
  items: readonly VaultItem[];
}>;

function cleanName(value: string): string {
  return value.trim().slice(0, 128);
}

async function addMembership(
  tomb: string,
  directory: LocalDirectory,
  personId: string,
): Promise<void> {
  const organization = directory.entries.find(
    (entry) => entry.kind === "organization" && entry.enabled,
  );
  if (!organization) return;
  if (
    directory.memberships.some(
      (row) =>
        row.organizationId === organization.id && row.principalId === personId,
    )
  )
    return;
  await withLocalDirectoryLock(tomb, () =>
    commitLocalDirectoryUnderLock(tomb, directory.revision, {
      action: "membership",
      organizationId: organization.id,
      principalId: personId,
      role: "member",
    }),
  );
}

async function ensurePerson(
  tomb: string,
  guestName: string,
  audience: SessionAudience,
  peopleIds: readonly string[],
): Promise<LocalIdentity> {
  const directory = await readLocalDirectory(tomb);
  const enabledPeople = directory.entries.filter(
    (entry) => entry.kind === "person" && entry.enabled,
  );
  if (audience === "people") {
    const selected = enabledPeople.find(
      (entry) =>
        peopleIds.includes(entry.id) && entry.name === cleanName(guestName),
    );
    if (!selected)
      throw new LocalDirectoryError(
        "This name is not on the people selected for this session.",
      );
    return selected;
  }
  const existing = enabledPeople.find(
    (entry) => entry.name === cleanName(guestName),
  );
  if (existing) return existing;
  const next = await withLocalDirectoryLock(tomb, () =>
    commitLocalDirectoryUnderLock(tomb, directory.revision, {
      action: "create",
      kind: "person",
      name: cleanName(guestName),
    }),
  );
  const person = next.entries.find(
    (entry) => entry.kind === "person" && entry.name === cleanName(guestName),
  );
  if (!person)
    throw new LocalDirectoryError("The new local identity was not created.");
  await addMembership(tomb, next, person.id);
  return person;
}

function vaultPolicy(policy: SharePolicy): "open" | "items" {
  return policy === "read" ? "open" : "items";
}

function itemPolicy(policy: SharePolicy): "read" | "use" {
  return policy === "read" ? "read" : "use";
}

function resourcesFor(
  scope: ShareScope,
  items: readonly VaultItem[],
): readonly { kind: "vault" | "item"; id: string; label: string }[] {
  if (scope.kind === "none") return [];
  if (scope.kind === "vault")
    return [
      { kind: "vault", id: vaultStore.activeTomb(), label: "Live session" },
    ];
  return scope.ids.map((id) => {
    const item = items.find((entry) => entry.id === id);
    if (!item || item.deletedAt !== null)
      throw new LocalDirectoryError(
        "A shared item is no longer in the open vault.",
      );
    return { kind: "item" as const, id, label: item.name.slice(0, 128) };
  });
}

/**
 * Create or find the claimed person, then write the session's scope as
 * shares. The `All users` audience writes one group share per resource;
 * everyone else writes a share for the person. Throws when the claimed name
 * is not on a selected-people list or the open vault lost an item.
 */
export async function provisionLiveSessionGuest(
  input: ProvisionInput,
): Promise<void> {
  if (input.guest.kind !== "person") return;
  // A host is only live while its vault is open; a locked test fixture or a
  // session that lost its vault cannot write an identity or a share.
  if (sessionProvisionSeams.vaultStatus() !== "unlocked") return;
  const guestName = cleanName(input.guest.name);
  if (!guestName) throw new LocalDirectoryError("A joiner needs a name.");
  const person = await ensurePerson(
    input.tomb,
    guestName,
    input.audience,
    input.peopleIds,
  );
  const principalId =
    input.audience === "all-users" ? ALL_USERS_GROUP_ID : person.id;
  const resources = resourcesFor(input.scope, input.items);
  if (resources.length === 0) return;
  const durationSeconds = Math.max(
    60,
    Math.min(7 * 86_400, Math.max(1, input.minutes) * 60),
  );
  for (const resource of resources) {
    await name(input.tomb, (named) =>
      createLocalShareAs(
        named,
        {
          principalId,
          resourceKind: resource.kind,
          resourceId: resource.id,
          resourceLabel: resource.label,
          policy:
            resource.kind === "vault"
              ? vaultPolicy(input.policy)
              : itemPolicy(input.policy),
          durationSeconds,
          sessionId: input.hostId,
        },
        systemShareWrite(named),
        { freeDuration: true },
      ),
    );
  }
}
