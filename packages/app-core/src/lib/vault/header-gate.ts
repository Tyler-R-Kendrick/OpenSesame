/**
 * Does this header carry a challenge that can actually open it?
 *
 * A guest tomb's header alone does not mean "a vault is sealed here": a guest
 * who merely used the app leaves a wrap-less record behind, and the road in is
 * still guest entry. It counts as a locked vault the moment it carries a gate —
 * a passkey, PIN or password wrap, or an authenticator code — and then that
 * gate is what the unlock asks for.
 */
import type { VaultHeader } from "@opensesame/vault-core";
import { hasSecondStep, primaryUnlockCount } from "./unlock-methods.js";

export function headerCarriesGate(header: VaultHeader | null): boolean {
  return !!header && (primaryUnlockCount(header) > 0 || hasSecondStep(header));
}
