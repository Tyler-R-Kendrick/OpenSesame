import type {
  ProtectionContext,
  RootProtectionManifest,
} from "@opensesame/vault-core";

/** Context binding shared by enrollment and recovery without loading crypto. */
export function contextForRecord(
  manifest: RootProtectionManifest,
  protectorId: string,
): ProtectionContext {
  return {
    vaultId: manifest.vaultId,
    rootKeyId: manifest.rootKeyId,
    rootEpoch: manifest.rootEpoch,
    protectorId,
    purpose: manifest.purpose,
  };
}
