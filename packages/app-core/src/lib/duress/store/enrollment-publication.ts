/**
 * Recoverable enrollment publication (STORE-B) + pre-unlock opaque metadata (STORE-D).
 * Manifests are plaintext digests/flags only — never codes, PRF, or compartment keys.
 */

import {
  type EnrollmentManifest,
  EnrollmentManifestSchema,
} from "@opensesame/contracts/duress";
import {
  COMPARTMENT_REGISTRY_KEY,
  type CompartmentRegistry,
  clearCompartmentRegistry,
  publishCompartmentRegistry,
} from "./compartment-registry.js";
import {
  clearJournal,
  readJournalPayload,
  recoverJournal,
  writeJournal,
} from "./journal.js";
import {
  alternateWrapperWarnings,
  inventoryLegacyWrappers,
} from "./legacy-wrappers.js";
import {
  assessDurableStorage,
  parseEnrollmentManifest,
} from "./storage-resilience.js";

export const ENROLLMENT_MANIFEST_KEY = "duress.enrollment-manifest.v1";

export type EnrollmentPublication = Readonly<{
  manifest: EnrollmentManifest;
  registry: CompartmentRegistry;
}>;

export type OpaqueEnrollmentMetadata = Readonly<{
  armed: boolean;
  slotCount: number;
  policyRevision: number;
  keyEpoch: number;
  vaultRef: string;
  deviceBindingRef: string;
  readiness: EnrollmentManifest["readiness"];
  durableStorageReady: boolean;
}>;

export function readEnrollmentManifest(): EnrollmentManifest | null {
  const payload = readJournalPayload<EnrollmentManifest>(
    ENROLLMENT_MANIFEST_KEY,
  );
  if (!payload) return null;
  const parsed = parseEnrollmentManifest(payload);
  return parsed.ok ? parsed.manifest : null;
}

/** Pre-unlock safe surface — never includes secrets or sealed settings. */
export function readOpaqueEnrollmentMetadata(): OpaqueEnrollmentMetadata | null {
  const manifest = readEnrollmentManifest();
  if (!manifest) return null;
  const storage = assessDurableStorage();
  return {
    armed: manifest.armed,
    slotCount: manifest.slotCount,
    policyRevision: manifest.policyRevision,
    keyEpoch: manifest.keyEpoch,
    vaultRef: manifest.vaultRef,
    deviceBindingRef: manifest.deviceBindingRef,
    readiness: manifest.readiness,
    durableStorageReady: storage.ready,
  };
}

/**
 * Publish enrollment + compartment registry with recoverable journals.
 * Fails closed when durable storage is required but unavailable.
 */
export async function publishEnrollment(input: {
  manifest: EnrollmentManifest;
  registry: CompartmentRegistry;
  requireDurable?: boolean;
}): Promise<
  | { ok: true; revision: number; wrapperWarnings: string[] }
  | { ok: false; code: string; message: string }
> {
  const checked = EnrollmentManifestSchema.safeParse(input.manifest);
  if (!checked.success) {
    return {
      ok: false,
      code: "invalid_manifest",
      message: checked.error.message,
    };
  }
  if (input.requireDurable !== false) {
    const storage = assessDurableStorage();
    if (!storage.ready && storage.durability === "memory") {
      return {
        ok: false,
        code: "undurable_storage",
        message: "Enrollment requires durable local storage.",
      };
    }
  }

  const inventory = inventoryLegacyWrappers();
  const wrapperWarnings = alternateWrapperWarnings(
    inventory,
    input.manifest.policyId,
  );

  const published = await commitEnrollmentJournals({
    manifest: checked.data,
    registry: input.registry,
    requireDurable: input.requireDurable ?? true,
  });
  if (!published.ok) return published;

  return {
    ok: true,
    revision: published.revision,
    wrapperWarnings,
  };
}

type EnrollmentJournalInput = {
  manifest: EnrollmentManifest;
  registry: CompartmentRegistry;
  requireDurable: boolean;
};

async function commitEnrollmentJournals(
  input: EnrollmentJournalInput,
): Promise<
  { ok: true; revision: number } | { ok: false; code: string; message: string }
> {
  const priorRegistry = recoverJournal<CompartmentRegistry>(
    COMPARTMENT_REGISTRY_KEY,
  );
  const priorManifestRevision =
    recoverJournal<EnrollmentManifest>(ENROLLMENT_MANIFEST_KEY)?.revision ?? 0;

  const registryResult = await publishCompartmentRegistry(input.registry, {
    requireDurable: input.requireDurable,
    expectedRevision: priorRegistry?.revision ?? 0,
  });
  if (!registryResult.ok) {
    return {
      ok: false,
      code: registryResult.code,
      message: registryResult.message,
    };
  }

  const manifestResult = await writeJournal(
    ENROLLMENT_MANIFEST_KEY,
    input.manifest,
    {
      requireDurable: input.requireDurable,
      expectedRevision: priorManifestRevision,
    },
  );
  if (!manifestResult.ok) {
    await restoreCompartmentRegistry(
      priorRegistry?.payload ?? null,
      registryResult.revision,
      input.requireDurable,
    );
    return {
      ok: false,
      code: manifestResult.code,
      message: manifestResult.message,
    };
  }
  return { ok: true, revision: manifestResult.revision };
}

/** Best-effort compensation when the manifest half of a publish fails. */
async function restoreCompartmentRegistry(
  prior: CompartmentRegistry | null,
  publishedRevision: number,
  requireDurable: boolean,
): Promise<void> {
  if (prior === null) {
    clearCompartmentRegistry();
    return;
  }
  await publishCompartmentRegistry(prior, {
    requireDurable,
    expectedRevision: publishedRevision,
  }).catch(() => undefined);
}

export function recoverEnrollmentPublication(): EnrollmentManifest | null {
  const recovered = recoverJournal<EnrollmentManifest>(ENROLLMENT_MANIFEST_KEY);
  if (!recovered) return null;
  const parsed = parseEnrollmentManifest(recovered.payload);
  return parsed.ok ? parsed.manifest : null;
}

export function clearEnrollmentPublication(): void {
  clearJournal(ENROLLMENT_MANIFEST_KEY);
}
