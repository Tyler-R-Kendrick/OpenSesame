/** Pure capsule context shared by bootstrap and deferred management operations. */
import type {
  ProtectionContext,
  RootProtectionManifest,
} from "@opensesame/vault-core";

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
