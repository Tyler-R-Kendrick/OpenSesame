/**
 * The Pages capability catalog (ownership.md §2, §5).
 *
 * One authored list of descriptors, digested once by `buildCatalog`. Every
 * runtime, editor and build step reads this object; none redefines it.
 * Descriptors are data only — no feature imports, no callbacks — so the
 * catalog can be validated, digested and shown before any optional module
 * exists in the realm.
 */

import {
  type CapabilityCatalog,
  type CapabilityDescriptor,
  type CapabilityId,
  buildCatalog,
} from "@opensesame/capability-composition";
import { CORE_DESCRIPTORS } from "./catalog-core.js";
import { IDENTITY_FAMILY_DESCRIPTORS } from "./catalog-optional-identity.js";
import { SERVICE_FAMILY_DESCRIPTORS } from "./catalog-optional-services.js";
import { VAULT_FAMILY_DESCRIPTORS } from "./catalog-optional-vault.js";

export const CATALOG_VERSION = 1;

export const CAPABILITY_CATALOG: CapabilityCatalog = buildCatalog(
  [
    ...CORE_DESCRIPTORS,
    ...VAULT_FAMILY_DESCRIPTORS,
    ...IDENTITY_FAMILY_DESCRIPTORS,
    ...SERVICE_FAMILY_DESCRIPTORS,
  ],
  CATALOG_VERSION,
);

/**
 * The ids the composition mandate's example documents use. They must all
 * exist so those documents validate; the catalog test pins them.
 */
export const PROMPT_EXAMPLE_IDS: readonly CapabilityId[] = [
  "vault.passwords",
  "backup.local-encrypted",
  "vault.passkey-records",
  "sharing.household",
  "connectors.external",
  "enterprise.ca-administration",
  "enterprise.directory-provisioning",
  "agents.webmcp",
  "support.remote-ai",
  "telemetry.external",
];

export function describeCapability(
  id: CapabilityId,
): CapabilityDescriptor | null {
  return (
    CAPABILITY_CATALOG.capabilities.find((entry) => entry.id === id) ?? null
  );
}

export function coreCapabilityIds(): CapabilityId[] {
  return CAPABILITY_CATALOG.capabilities
    .filter((entry) => entry.tier === "core")
    .map((entry) => entry.id);
}

export function optionalCapabilityIds(): CapabilityId[] {
  return CAPABILITY_CATALOG.capabilities
    .filter((entry) => entry.tier === "optional")
    .map((entry) => entry.id);
}

export function isKnownCapability(id: string): boolean {
  return CAPABILITY_CATALOG.capabilities.some((entry) => entry.id === id);
}
