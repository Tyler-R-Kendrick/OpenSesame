/**
 * Default Access configuration for this vault — dogfood the local IAM plane.
 *
 * Opening Access (or Identity) should already show the current person, this
 * app, this device, and standing shares for every vault the owner can use.
 * The built-in agent is in the directory and holds no standing grant.
 * Guest principals are per-session (Guest N) and live in the guest tomb only;
 * they are never a shared singleton account for connectors.
 */

import { catalogProvider } from "./connector-catalog.js";
import { getBundledProviders } from "./embedded-catalog.js";
import { listAccessAuditEvents } from "./local-access-audit.js";
import { ensureThisDevice } from "./local-devices.js";
import {
  currentOwnerPersonName,
  ensureOwnerPerson,
} from "./local-directory-bootstrap.js";
import { type LocalDirectory, readLocalDirectory } from "./local-directory.js";
import { guestSessionPersonLocked, isGuestPersonEntry } from "./local-guest.js";
import { ensureLocalShare } from "./local-share-grants-approvals.js";
import { loadSettings } from "./settings.js";
import { standingConnectionRevoked } from "./standing-connection-grants.js";
import { listDeviceVaults } from "./vaults.js";
import { GUEST_TOMB } from "./vfs.js";

function providerLabel(providerId: string): string {
  return (
    getBundledProviders().find((row) => row.id === providerId)?.displayName ??
    catalogProvider(providerId)?.displayName ??
    providerId
  );
}

/** Capability connectors that already have a provider chosen on this device. */
function configuredProviderIds(): readonly string[] {
  const map = loadSettings().capabilityConnectors;
  const ids = new Set<string>();
  for (const binding of Object.values(map)) {
    if (binding.providerId.trim()) ids.add(binding.providerId.trim());
  }
  return [...ids];
}

function findGuestPerson(directory: LocalDirectory) {
  return directory.entries.find((entry) => isGuestPersonEntry(entry));
}

function findOwnerPerson(directory: LocalDirectory) {
  const guest = findGuestPerson(directory);
  const people = directory.entries.filter((entry) => entry.kind === "person");
  return people.find((entry) => entry.id !== guest?.id) ?? guest;
}

async function ensureDefaultShares(tomb: string): Promise<void> {
  const directory = await readLocalDirectory(tomb);
  const owner = findOwnerPerson(directory);
  const guest = findGuestPerson(directory);
  if (!owner) return;

  const vaults = listDeviceVaults();
  const ownedVaults = vaults.filter((vault) => vault.kind !== "guest");
  const guestVault = vaults.find((vault) => vault.kind === "guest");

  // Owner standing shares — only when the session owner is not the guest.
  // The built-in agent is not granted here. An agent grant is a person's
  // approval, and this renewer must not hand it a standing week.
  if (owner.id !== guest?.id) {
    for (const vault of ownedVaults) {
      await ensureLocalShare(tomb, {
        principalId: owner.id,
        resourceKind: "vault",
        resourceId: vault.id,
        resourceLabel: vault.label,
        policy: "items",
      });
    }
  }

  // Guest vault + this tomb's guest principal(s) — each Guest N is distinct.
  if (guestVault && guest) {
    for (const guestPerson of directory.entries.filter(isGuestPersonEntry)) {
      await ensureLocalShare(tomb, {
        principalId: guestPerson.id,
        resourceKind: "vault",
        resourceId: guestVault.id,
        resourceLabel: guestVault.label,
        policy: "open",
      });
      await ensureLocalShare(tomb, {
        principalId: guestPerson.id,
        resourceKind: "vault",
        resourceId: guestVault.id,
        resourceLabel: guestVault.label,
        policy: "items",
      });
    }
  }

  await ensureConnectorShares(tomb, owner.id === guest?.id ? null : owner.id);
}

/**
 * Standing connector grants: the owner may invoke. The built-in agent gets
 * none. Guests do not receive connector use by default — operators grant
 * that on Access. A grant a person revoked on Access stays revoked.
 */
async function ensureConnectorShares(
  tomb: string,
  ownerId: string | null,
): Promise<void> {
  // An unreadable trail fails closed: it is where a person's revocations live,
  // so with it unreadable no standing connector grant is issued again. The
  // rest of the directory seeds as before; the person is not locked out of
  // Identity and Access by a damaged log, only left without a grant they may
  // have taken away.
  const trail = await listAccessAuditEvents(tomb).catch(() => null);
  if (trail === null || !ownerId) return;
  for (const providerId of configuredProviderIds()) {
    const grant = {
      resourceId: providerId,
      principalId: ownerId,
      policy: "invoke",
    };
    if (standingConnectionRevoked(trail, grant)) continue;
    await ensureLocalShare(tomb, {
      principalId: ownerId,
      resourceKind: "connection",
      resourceId: providerId,
      resourceLabel: providerLabel(providerId),
      policy: "invoke",
    });
  }
}

/**
 * Ensure the local IAM surface this app dogfoods: owner, (session) guest,
 * org, Pages app, support agent (with no standing grant), this device, and
 * the owner's standing shares.
 */
export async function ensureDefaultAccess(tomb: string): Promise<void> {
  const personName =
    tomb === GUEST_TOMB
      ? (await guestSessionPersonLocked()).name
      : currentOwnerPersonName();
  await ensureOwnerPerson(tomb, personName);
  await ensureThisDevice(tomb);
  await ensureDefaultShares(tomb);
}
