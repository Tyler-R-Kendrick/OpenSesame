/** Fixed current policy proof only; the private Store owns primary and configured factors. */
import {
  type VaultHeader,
  assertFactorConfigurationBinding,
} from "@opensesame/vault-core";
import { verifyManifestAuth } from "./protection/manifest-auth.js";
export async function verifyOriginalUnlockPolicy(
  header: VaultHeader,
  root: Uint8Array | undefined,
  check: () => void,
) {
  if (header.protection) {
    if (!root) throw new Error("Original unlock policy changed.");
    await verifyManifestAuth(root, header.protection);
    check();
    const gates = header.protection.legacyGates;
    if (
      gates &&
      (gates.totpEnrolled !== Boolean(header.unlocks?.totp) ||
        gates.emailEnrolled !== Boolean(header.unlocks?.email) ||
        gates.smsEnrolled !== Boolean(header.unlocks?.sms) ||
        gates.recoveryCodesEnrolled !== Boolean(header.unlocks?.recovery))
    )
      throw new Error("Original unlock policy changed.");
    if (header.protection.factorConfiguration) {
      await assertFactorConfigurationBinding(header);
      check();
    }
  }
}
