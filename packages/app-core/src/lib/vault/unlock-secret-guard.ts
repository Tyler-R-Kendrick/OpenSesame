/**
 * Policy for a new ordinary unlock secret: the PIN or master-password floor,
 * then the duress collision check. A secret equal to an enrolled duress code
 * would be matched by the trigger before any unwrap and open the decoy in
 * place of this vault, every time — so it is refused where it is set, as the
 * trigger is refused when it equals an existing secret.
 */

import { assertNotDecoySession } from "../decoy-session.js";
import { activeProject } from "../projects.js";
import { assertMasterPasswordPolicy } from "./prefs.js";
import { assertPinPolicy } from "./unlock-methods.js";

export async function assertNewPin(pin: string): Promise<void> {
  const generation = assertNotDecoySession();
  assertPinPolicy(pin);
  await assertNoDuressCollision(pin, generation);
}

export async function assertNewPassword(
  password: string,
  tomb: string = activeProject().id,
): Promise<void> {
  const generation = assertNotDecoySession();
  assertMasterPasswordPolicy(password);
  await assertNoDuressCollision(password, generation);
  assertNotDecoySession(generation);
  const { assertNotRetiredCredential } = await retiredGuards(generation);
  await assertNotRetiredCredential(password, tomb);
  assertNotDecoySession(generation);
}

/** Serialize trap classification with the complete password header write. */
export async function withNewPassword<T>(
  password: string,
  tomb: string,
  work: () => Promise<T>,
): Promise<T> {
  const generation = assertNotDecoySession();
  assertMasterPasswordPolicy(password);
  await assertNoDuressCollision(password, generation);
  assertNotDecoySession(generation);
  const { withRetiredCredentialChange } = await retiredGuards(generation);
  const result = await withRetiredCredentialChange(password, tomb, async () => {
    assertNotDecoySession(generation);
    const value = await work();
    assertNotDecoySession(generation);
    return value;
  });
  assertNotDecoySession(generation);
  return result;
}

/** Collision checking loads only for a password operation admitted in this realm. */
async function retiredGuards(generation: number) {
  const guards = await import("../retired-credentials/index.js");
  assertNotDecoySession(generation);
  return guards;
}

/** Duress slot crypto loads only for a policy-admitted ordinary secret change. */
async function assertNoDuressCollision(code: string, generation: number) {
  const { assertNotDuressCode } = await import(
    "../duress/store/duress-code-probe.js"
  );
  assertNotDecoySession(generation);
  await assertNotDuressCode(code);
  assertNotDecoySession(generation);
}
