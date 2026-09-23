/**
 * Policy for a new ordinary unlock secret: the PIN or master-password floor,
 * then the duress collision check. A secret equal to an enrolled duress code
 * would be matched by the trigger before any unwrap and open the decoy in
 * place of this vault, every time — so it is refused where it is set, as the
 * trigger is refused when it equals an existing secret.
 */

import { assertNotDuressCode } from "../duress/store/duress-code-probe.js";
import { assertMasterPasswordPolicy } from "./prefs.js";
import { assertPinPolicy } from "./unlock-methods.js";

export async function assertNewPin(pin: string): Promise<void> {
  assertPinPolicy(pin);
  await assertNotDuressCode(pin);
}

export async function assertNewPassword(password: string): Promise<void> {
  assertMasterPasswordPolicy(password);
  await assertNotDuressCode(password);
}
