/** NEW cryptographic material only. No current-root, owner, Fresh or REAL admission. */
import {
  ROOT_KEY_BYTES,
  type VaultHeader,
  createVault,
  prepareFactorConfigurationBinding,
} from "@opensesame/vault-core";
import { readPagesRetiredCredentialHeader } from "../retired-credentials/context-v2-header.js";
import { sealAuthenticatedManifest } from "./protection/manifest-auth.js";
import { migrateLegacyHeaderToManifest } from "./protection/migrate-legacy.js";

const actualCreate = createVault;
const actualProject = migrateLegacyHeaderToManifest;
const actualBinding = prepareFactorConfigurationBinding;
const actualSeal = sealAuthenticatedManifest;
const actualHeader = readPagesRetiredCredentialHeader;
/**
 * Called only by the actual NEW material factories before their first publication.
 * This never migrates an existing policy or accepts completed-factor/owner facts.
 * The root and header are copied before awaits; the caller retains its new root.
 */
export async function bindNewVaultMaterialHeader(
  header: VaultHeader,
  rawVaultKey: Uint8Array,
): Promise<VaultHeader> {
  if (
    header.protection !== undefined ||
    !(rawVaultKey instanceof Uint8Array) ||
    rawVaultKey.length !== ROOT_KEY_BYTES ||
    header.unlocks?.totp !== undefined ||
    header.unlocks?.email !== undefined ||
    header.unlocks?.sms !== undefined ||
    header.unlocks?.recovery !== undefined
  )
    throw new Error("Only original new vault material can be prepared.");
  const copied = structuredClone(header);
  const root = rawVaultKey.slice();
  try {
    const { manifest } = actualProject({ header: copied });
    if (!manifest.records.length)
      throw new Error("New vault material requires an actual primary wrap.");
    const prepared: VaultHeader = { ...copied, protection: manifest };
    const factorConfiguration = await actualBinding(prepared);
    const protection = await actualSeal(root, {
      ...manifest,
      factorConfiguration,
    });
    const next: VaultHeader = { ...copied, protection };
    actualHeader(JSON.stringify(next));
    return next;
  } finally {
    root.fill(0);
  }
}
/** Actual fresh password material producer; cleanup owns only its minted root. */
export async function createNewFactorBoundPasswordVault(
  password: string,
  hint?: string,
) {
  const material = await actualCreate(password, hint);
  try {
    const header = await bindNewVaultMaterialHeader(
      material.header,
      material.rawVaultKey,
    );
    return { ...material, header };
  } catch (error) {
    material.rawVaultKey.fill(0);
    throw error;
  }
}
