/** Synchronous owner policy exposes no password proof or mutation authority. */
import type {
  RootProtectionManifest,
  VaultHeader,
} from "@opensesame/vault-core";
import { parseRootProtectionManifest } from "../vault/protection/parse.js";
import { readTombHeader } from "../vault/store-header.js";
export const retiredCredentialOwnerSeams = {
  isRealOwner: (_tomb: string): boolean => false,
};

function headerRequiresMfa(header: VaultHeader): boolean {
  return Boolean(
    header.unlocks?.totp || header.unlocks?.email || header.unlocks?.sms,
  );
}
function manifestRequiresMfa(manifest: RootProtectionManifest): boolean {
  const gates = manifest.legacyGates;
  return Boolean(
    gates?.totpEnrolled ||
      gates?.emailEnrolled ||
      gates?.smsEnrolled ||
      manifest.purpose !== "human-vault-root",
  );
}
export function authoritativeHeader(header: VaultHeader): VaultHeader {
  if (headerRequiresMfa(header))
    throw new Error(
      "Retired credential management requires a fresh multi-factor ceremony for this vault.",
    );
  if (!header.protection) {
    if (!header.kdf || !header.wrap)
      throw new Error("A current password protector is required.");
    return header;
  }
  const manifest = parseRootProtectionManifest(
    JSON.stringify(header.protection),
  );
  if (manifestRequiresMfa(manifest))
    throw new Error(
      "Retired credential management requires a fresh multi-factor ceremony for this vault.",
    );
  if (
    manifest.records.length !== 1 ||
    manifest.records[0]?.kind !== "password" ||
    manifest.records[0].proofStatus !== "verified"
  )
    throw new Error(
      "Retired credential management currently requires one verified password protector.",
    );
  const record = manifest.records[0];
  return {
    ...header,
    kdf: record.kdf,
    wrap: record.wrap,
    protection: manifest,
  };
}
export function retiredCredentialEnrollmentSupported(tomb: string): boolean {
  const header = readTombHeader(tomb);
  if (!header) return false;
  try {
    authoritativeHeader(header);
    return true;
  } catch {
    return false;
  }
}
