/**
 * Refuse an ordinary unlock secret that is also an enrolled duress code — the
 * inverse of `ordinary-unlock-probe.ts` (TRIGGER-F).
 *
 * The duress check runs on the complete code before any vault unwrap, so a PIN
 * or master password set equal to an armed trigger would open the decoy every
 * time and never the vault it was set for. Enrollment is device-wide, so the
 * one persisted state is tried, without touching the attempt policy or the
 * incident fence: this is a probe, not an unlock.
 */

import { assertTriggerCodeLength } from "../crypto/slots.js";
import { openEnrolledTriggerPlaintext } from "../trigger/enrollment-match.js";
import {
  type EnrollmentState,
  expectFrom,
} from "../trigger/enrollment-state.js";
import { loadEnrollmentStateForUnlock } from "./unlock-enrollment.js";

/**
 * True when `code` opens a code-only trigger slot in `state`. A UV-gated
 * trigger is tried as if verification passed, since the code alone is what
 * would collide; a PRF-bound trigger also needs its passkey and so cannot be
 * reached by a typed secret.
 */
export async function codeOpensDuressTrigger(
  code: string,
  state: EnrollmentState | null = loadEnrollmentStateForUnlock(),
): Promise<boolean> {
  if (!state || state.triggers.length === 0) return false;
  try {
    // A code outside the trigger shape can never be matched at unlock either
    // (`selectTrigger` answers "none" before opening a slot).
    assertTriggerCodeLength(code);
  } catch {
    return false;
  }
  const expect = expectFrom(state);
  for (const enrolled of state.triggers) {
    if (enrolled.triggerKind === "prf_and_code") continue;
    const plaintext = await openEnrolledTriggerPlaintext({
      enrolled,
      code,
      expect,
      userVerified: true,
    });
    if (plaintext) {
      plaintext.compartmentKey.fill(0);
      plaintext.actionCapability?.fill(0);
      return true;
    }
  }
  return false;
}

/** Throws `ambiguous_trigger` when `code` is an enrolled duress code. */
export async function assertNotDuressCode(
  code: string,
  state?: EnrollmentState | null,
): Promise<void> {
  const collides =
    state === undefined
      ? await codeOpensDuressTrigger(code)
      : await codeOpensDuressTrigger(code, state);
  if (collides) {
    throw new Error("ambiguous_trigger: collides with duress code");
  }
}
