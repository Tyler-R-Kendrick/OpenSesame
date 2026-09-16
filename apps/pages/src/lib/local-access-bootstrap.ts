/**
 * Default Access configuration for this vault — dogfood the local IAM plane.
 *
 * Opening Access (or Identity) should already show the current person, the
 * guest principal, this app, this device, and standing shares for every vault
 * the owner can use — including the guest vault, so guest access is
 * configurable rather than invisible. Nothing that the product itself needs
 * should wait for a blank Grant form.
 */

import { getBundledProviders } from "./embedded-catalog.js";
import { ensureThisDevice } from "./local-devices.js";
import {
  GUEST_PERSON_ID,
  GUEST_PERSON_NAME,
  SUPPORT_AGENT_ID,
  currentOwnerPersonName,
  ensureOwnerPerson,
} from "./local-directory-bootstrap.js";
import { type LocalDirectory, readLocalDirectory } from "./local-directory.js";
import { ensureLocalShare } from "./local-share-grants.js";
import { loadSettings } from "./settings.js";
import { listDeviceVaults } from "./vaults.js";

function providerLabel(providerId: string): string {
  return (
    getBundledProviders().find((row) => row.id === providerId)?.displayName ??
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
  return (
    directory.entries.find((entry) => entry.id === GUEST_PERSON_ID) ??
    directory.entries.find(
      (entry) => entry.kind === "person" && entry.name === GUEST_PERSON_NAME,
    )
  );
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
  if (owner.id !== guest?.id) {
    for (const vault of ownedVaults) {
      await ensureLocalShare(tomb, {
        principalId: owner.id,
        resourceKind: "vault",
        resourceId: vault.id,
        resourceLabel: vault.label,
        policy: "items",
      });
      await ensureLocalShare(tomb, {
        principalId: SUPPORT_AGENT_ID,
        resourceKind: "vault",
        resourceId: vault.id,
        resourceLabel: vault.label,
        policy: "open",
      });
    }
  }

  // Guest vault + guest principal — always dogfooded so Access can tighten.
  if (guestVault && guest) {
    await ensureLocalShare(tomb, {
      principalId: guest.id,
      resourceKind: "vault",
      resourceId: guestVault.id,
      resourceLabel: guestVault.label,
      policy: "open",
    });
    await ensureLocalShare(tomb, {
      principalId: guest.id,
      resourceKind: "vault",
      resourceId: guestVault.id,
      resourceLabel: guestVault.label,
      policy: "items",
    });
    await ensureLocalShare(tomb, {
      principalId: SUPPORT_AGENT_ID,
      resourceKind: "vault",
      resourceId: guestVault.id,
      resourceLabel: guestVault.label,
      policy: "open",
    });
  }

  for (const providerId of configuredProviderIds()) {
    const label = providerLabel(providerId);
    if (owner.id !== guest?.id) {
      await ensureLocalShare(tomb, {
        principalId: owner.id,
        resourceKind: "connection",
        resourceId: providerId,
        resourceLabel: label,
        policy: "invoke",
      });
    }
    // Guests do not receive connector use by default — operators grant that on Access.
    await ensureLocalShare(tomb, {
      principalId: SUPPORT_AGENT_ID,
      resourceKind: "connection",
      resourceId: providerId,
      resourceLabel: label,
      policy: "use",
    });
  }
}

/**
 * Ensure the local IAM surface this app dogfoods: owner, guest, org, Pages
 * app, support agent, this device, and standing shares for vaults/connectors.
 */
export async function ensureDefaultAccess(tomb: string): Promise<void> {
  await ensureOwnerPerson(tomb, currentOwnerPersonName());
  await ensureThisDevice(tomb);
  await ensureDefaultShares(tomb);
}
