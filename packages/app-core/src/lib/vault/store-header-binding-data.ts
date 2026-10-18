/** Private Store header-policy transition DATA; possession of a root never issues owner membership. */
import {
  type RootProtectionManifest,
  type VaultHeader,
  assertFactorConfigurationBinding,
  prepareFactorConfigurationBinding,
} from "@opensesame/vault-core";
import { reconciledProjection } from "./protection/browser-operation-data.js";
import {
  manifestWithoutAuth,
  sealAuthenticatedManifest,
  verifyManifestAuth,
} from "./protection/manifest-auth.js";
import { gatesFromUnlocks } from "./protection/migrate-legacy.js";
function allowedRootTurn(
  previous: RootProtectionManifest,
  next: RootProtectionManifest,
  turn: boolean,
) {
  return (
    turn &&
    next.vaultId === previous.vaultId &&
    next.purpose === previous.purpose &&
    next.rootKeyId !== previous.rootKeyId &&
    next.rootEpoch === previous.rootEpoch + 1 &&
    next.revision > previous.revision
  );
}
async function authenticatePriorHeader(
  previous: VaultHeader | null,
  next: RootProtectionManifest,
  root: Uint8Array,
  turn: boolean,
  check: () => void,
) {
  const prior = previous?.protection;
  if (!prior) return;
  if (allowedRootTurn(prior, next, turn)) return; // The private root-turn caller already replaced the original root and BODY.
  await verifyManifestAuth(root, prior);
  check();
  if (prior.factorConfiguration) {
    await assertFactorConfigurationBinding(previous);
    check();
  }
  if (
    next.vaultId !== prior.vaultId ||
    next.rootKeyId !== prior.rootKeyId ||
    next.rootEpoch !== prior.rootEpoch ||
    next.purpose !== prior.purpose
  )
    throw new Error(
      "Original header root identity changed outside its root turn.",
    );
  if (next.revision < prior.revision)
    throw new Error("Original header policy revision moved backwards.");
}
export async function bindOriginalHeaderPolicy(
  previous: VaultHeader | null,
  proposed: VaultHeader,
  raw: Uint8Array | null,
  turn: boolean,
  check: () => void,
): Promise<VaultHeader> {
  const manifest = proposed.protection;
  if (!manifest) {
    if (previous?.protection)
      throw new Error("The authenticated root manifest cannot be removed.");
    return proposed;
  }
  if (!raw) throw new Error("The original authenticated root is unavailable.");
  const root = raw.slice();
  try {
    check();
    await authenticatePriorHeader(previous, manifest, root, turn, check);
    await verifyManifestAuth(root, manifest);
    check();
    return await prepareHeaderPolicy(previous, proposed, manifest, root, check);
  } finally {
    root.fill(0);
  }
}

async function prepareHeaderPolicy(
  previous: VaultHeader | null,
  proposed: VaultHeader,
  manifest: RootProtectionManifest,
  root: Uint8Array,
  check: () => void,
): Promise<VaultHeader> {
  const unsigned = manifestWithoutAuth(manifest);
  const projected =
    previous?.protection === manifest
      ? (reconciledProjection(proposed, manifest) ?? unsigned)
      : unsigned;
  const legacyGates = gatesFromUnlocks(proposed.unlocks);
  const candidate: VaultHeader = {
    ...proposed,
    protection: { ...projected, legacyGates },
  };
  const expected = await prepareFactorConfigurationBinding(candidate);
  check();
  if (
    JSON.stringify(projected) ===
      JSON.stringify(manifestWithoutAuth(manifest)) &&
    JSON.stringify(legacyGates) === JSON.stringify(manifest.legacyGates) &&
    manifest.factorConfiguration?.digestB64 === expected.digestB64
  )
    return proposed;
  const priorRevision = previous?.protection?.revision ?? -1;
  const revision = Math.max(projected.revision, priorRevision + 1);
  if (!Number.isSafeInteger(revision))
    throw new Error("Header policy revision exhausted.");
  const next: VaultHeader = {
    ...candidate,
    protection: { ...projected, legacyGates, revision },
  };
  const factorConfiguration = await prepareFactorConfigurationBinding(next);
  check();
  next.protection = await sealAuthenticatedManifest(root, {
    ...manifestWithoutAuth(next.protection ?? manifest),
    factorConfiguration,
  });
  check();
  return next;
}
