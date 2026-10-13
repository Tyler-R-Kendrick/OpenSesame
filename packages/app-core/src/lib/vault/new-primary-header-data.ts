/** NEW setup candidate header DATA; shape or proof here never establishes NEW intent, factors or REAL. */
import {
  type VaultHeader,
  assertFactorConfigurationBinding,
  prepareFactorConfigurationBinding,
} from "@opensesame/vault-core";
import { readPagesRetiredCredentialHeader } from "../retired-credentials/context-v2-header.js";
import { sealAuthenticatedManifest } from "./protection/manifest-auth.js";
import { migrateLegacyHeaderToManifest } from "./protection/migrate-legacy.js";

const actualHeader = readPagesRetiredCredentialHeader;
const actualAssert = assertFactorConfigurationBinding;
const actualBinding = prepareFactorConfigurationBinding;
const actualSeal = sealAuthenticatedManifest;
const actualProject = migrateLegacyHeaderToManifest;
function unavailable(): never {
  throw new Error("Original new primary header is unavailable.");
}
/** Strict existing bound candidate only. Current-root/NEW provenance is owned by the private factory, never this parser. */
export function readBoundNewPrimaryHeaderData(
  wire: string,
  primary: "password" | "pin",
): VaultHeader {
  const header = actualHeader(wire);
  const records = header.protection.records;
  if (
    records.length !== 1 ||
    records[0]?.kind !== primary ||
    header.protection.factorConfiguration === undefined
  )
    unavailable();
  return header;
}
/** Caller subsequently authenticates the actual Root MAC + BODY with the independently derived primary root. */
export async function prepareNewPrimaryHeaderData(
  header: VaultHeader,
  rawRoot: Uint8Array,
): Promise<VaultHeader> {
  if (header.protection !== undefined) {
    await actualAssert(header);
    return header;
  }
  const projected = actualProject({
    header,
    rootEpoch: 1,
    passkeyRpId: "primary-setup.opensesame.invalid",
  }).manifest;
  const unsigned = { ...projected, revision: 1 };
  const selected: VaultHeader = { ...header, protection: unsigned };
  const factorConfiguration = await actualBinding(selected);
  return {
    ...header,
    protection: await actualSeal(rawRoot, {
      ...unsigned,
      factorConfiguration,
    }),
  };
}
