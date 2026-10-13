/** Existing legacy policy binding candidate DATA. No IO, factor completion, lease or REAL grant. */
import {
  ROOT_KEY_BYTES,
  type VaultHeader,
  assertFactorConfigurationBinding,
  prepareFactorConfigurationBinding,
} from "@opensesame/vault-core";
import { readPagesRetiredCredentialHeader } from "../retired-credentials/context-v2-header.js";
import {
  manifestWithoutAuth,
  sealAuthenticatedManifest,
  verifyManifestAuth,
} from "./protection/manifest-auth.js";
const actualHeader = readPagesRetiredCredentialHeader;
const actualVerify = verifyManifestAuth;
const actualUnsigned = manifestWithoutAuth;
const actualBinding = prepareFactorConfigurationBinding;
const actualSeal = sealAuthenticatedManifest;
const actualAssert = assertFactorConfigurationBinding;
function unavailable(): never {
  throw new Error("Original legacy policy binding is unavailable.");
}
/**
 * The actual private caller must first authenticate original root/MAC/BODY/key,
 * then consume configured factors before publishing this exact candidate.
 * This strict source never replaces a present-but-invalid full binding.
 */
export async function prepareCapturedLegacyPolicyBindingData(
  expectedHeader: string,
  rawRoot: Uint8Array,
  bodyRevision: number,
  original: () => void,
) {
  original();
  if (!(rawRoot instanceof Uint8Array) || rawRoot.length !== ROOT_KEY_BYTES)
    unavailable();
  const root = rawRoot.slice();
  try {
    const header = actualHeader(expectedHeader);
    if (
      header.protection.factorConfiguration !== undefined ||
      !Number.isSafeInteger(bodyRevision) ||
      bodyRevision < (header.bodyRev ?? 0)
    )
      unavailable();
    await actualVerify(root, header.protection);
    original();
    const revision = header.protection.revision + 1;
    if (!Number.isSafeInteger(revision)) unavailable();
    const unsigned = actualUnsigned(header.protection);
    const prepared: VaultHeader = {
      ...header,
      bodyRev: bodyRevision,
      protection: { ...unsigned, revision },
    };
    const factorConfiguration = await actualBinding(prepared);
    original();
    const protection = await actualSeal(root, {
      ...unsigned,
      revision,
      factorConfiguration,
    });
    original();
    const next: VaultHeader = { ...prepared, protection };
    const headerText = JSON.stringify(next);
    const parsed = actualHeader(headerText);
    await actualVerify(root, parsed.protection);
    original();
    await actualAssert(parsed);
    original();
    return Object.freeze({
      previousHeader: expectedHeader,
      header: Object.freeze(next),
      headerText,
    });
  } finally {
    root.fill(0);
  }
}
