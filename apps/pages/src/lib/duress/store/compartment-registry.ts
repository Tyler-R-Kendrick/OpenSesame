/**
 * Independent vs shared-root compartment registry (STORE-A).
 * Shared-root project tombs share the production wrap; independent compartments
 * hold their own roots and must never be admitted via sibling-key carry.
 */

import {
  type JournalWriteResult,
  clearJournal,
  readJournalPayload,
  recoverJournal,
  writeJournal,
} from "./journal.js";

export const COMPARTMENT_REGISTRY_KEY = "duress.compartment-registry.v1";

export type CompartmentKind = "shared_root" | "independent";

export type CompartmentEntry = Readonly<{
  tomb: string;
  kind: CompartmentKind;
  /** Profile that owns admission of this compartment's root, when independent. */
  profileId: string | null;
  /** Digests/labels of roots admitted to open this compartment (never raw keys). */
  admittedRootDigests: readonly string[];
}>;

export type CompartmentRegistry = Readonly<{
  vaultRef: string;
  deviceBindingRef: string;
  entries: readonly CompartmentEntry[];
}>;

export function emptyRegistry(
  vaultRef: string,
  deviceBindingRef: string,
): CompartmentRegistry {
  return { vaultRef, deviceBindingRef, entries: [] };
}

export function loadCompartmentRegistry(): CompartmentRegistry | null {
  return readJournalPayload<CompartmentRegistry>(COMPARTMENT_REGISTRY_KEY);
}

type Options = Readonly<{
  requireDurable?: boolean;
  expectedRevision?: number;
}>;
const defaultOptions = {} satisfies Options;

export async function publishCompartmentRegistry(
  registry: CompartmentRegistry,
  options: Options = defaultOptions,
): Promise<JournalWriteResult> {
  return writeJournal(COMPARTMENT_REGISTRY_KEY, registry, {
    requireDurable: options.requireDurable ?? true,
    expectedRevision: options.expectedRevision,
  });
}

export function clearCompartmentRegistry(): void {
  clearJournal(COMPARTMENT_REGISTRY_KEY);
}

export function findCompartment(
  registry: CompartmentRegistry | null,
  tomb: string,
): CompartmentEntry | null {
  if (!registry) return null;
  return registry.entries.find((e) => e.tomb === tomb) ?? null;
}

export function isIndependentCompartment(
  registry: CompartmentRegistry | null,
  tomb: string,
): boolean {
  return findCompartment(registry, tomb)?.kind === "independent";
}

/**
 * Whether the active session's root digest is admitted for `targetTomb`.
 * Shared-root tombs admit the vault's production root by default when enrolled.
 */
export function rootAdmittedForTarget(input: {
  registry: CompartmentRegistry | null;
  targetTomb: string;
  sessionRootDigest: string | null;
  admittedCompartmentRefs: readonly string[];
  fenceActive: boolean;
}): boolean {
  const { registry, targetTomb, sessionRootDigest, fenceActive } = input;
  if (fenceActive) {
    return input.admittedCompartmentRefs.includes(targetTomb);
  }
  const entry = findCompartment(registry, targetTomb);
  if (!entry) {
    // Unregistered tombs keep legacy shared-root project behavior.
    return true;
  }
  if (entry.kind === "shared_root") return true;
  if (!sessionRootDigest) return false;
  return entry.admittedRootDigests.includes(sessionRootDigest);
}

export function registryRevision(): number {
  return (
    recoverJournal<CompartmentRegistry>(COMPARTMENT_REGISTRY_KEY)?.revision ?? 0
  );
}
