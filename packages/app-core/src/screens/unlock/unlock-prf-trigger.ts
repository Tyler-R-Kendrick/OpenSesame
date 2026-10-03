/**
 * A `prf_and_code` duress trigger is bound to one passkey's PRF output, so a
 * road that cannot carry that output must not open the vault while it is armed
 * (ADR 0152, INV-03).
 *
 * Without this, an age-passkey tap (no PRF output) or a passkey capsule's other
 * credential routes a typed duress code to "no match", which reads as an
 * ordinary code and opens the real vault, silently ignoring it. Fail closed:
 * such a road is absent from the screen and refused by the gate, and a
 * completed code whose evidence cannot satisfy every armed trigger opens
 * nothing.
 */

import type { VaultHeader } from "@opensesame/vault-core";
import { bindingMatchesTrigger } from "../../lib/duress/trigger/enrollment-match.js";
import type { EnrolledTrigger } from "../../lib/duress/trigger/enrollment-state.js";
import { passkeyUnlockRecords } from "../../lib/vault/passkey-unlock-session.js";
import type { UnlockTabId } from "../../lib/vault/protection/unlock-protector-methods.js";
import { loadEnrollmentStateForUnlock } from "../../sections/settings/security/duress-unlock-bridge.js";

function armedPrfTriggers(): EnrolledTrigger[] {
  const state = loadEnrollmentStateForUnlock();
  if (!state?.armed) return [];
  return state.triggers.filter((t) => t.triggerKind === "prf_and_code");
}

export function prfTriggerArmed(): boolean {
  return armedPrfTriggers().length > 0;
}

/**
 * The credentials a passkey road may offer: `null` when no PRF trigger is
 * armed (any), otherwise the one credential every armed trigger is bound to.
 * Triggers bound to different credentials, or to none, leave no passkey that
 * can carry them all.
 */
export function credentialsCarryingArmedPrf(): readonly string[] | null {
  const armed = armedPrfTriggers();
  if (armed.length === 0) return null;
  const ids = new Set(armed.map((t) => t.credentialIdB64));
  const [only] = ids;
  return ids.size === 1 && only !== undefined ? [only] : [];
}

type Binding = { origin?: string; credentialIdB64?: string };

type Evidence = Readonly<{
  prfOutput: Uint8Array | null;
  credentialIdB64?: string | undefined;
  origin?: string | undefined;
}>;

/** Whether this evidence is what every armed `prf_and_code` trigger asks for. */
export function evidenceCarriesArmedPrf(evidence: Evidence): boolean {
  const armed = armedPrfTriggers();
  if (armed.length === 0) return true;
  if (!evidence.prfOutput) return false;
  const binding: Binding = {};
  if (evidence.origin !== undefined) binding.origin = evidence.origin;
  if (evidence.credentialIdB64 !== undefined) {
    binding.credentialIdB64 = evidence.credentialIdB64;
  }
  return armed.every((t) => bindingMatchesTrigger(t, binding));
}

/**
 * The tabs that survive an armed `prf_and_code` trigger: no age passkey, and a
 * passkey tab only when one of its credentials is the bound one.
 */
export function tabsThatCarryArmedPrf(
  tabs: UnlockTabId[],
  header: VaultHeader | null | undefined,
): UnlockTabId[] {
  const allowed = credentialsCarryingArmedPrf();
  if (allowed === null) return tabs;
  return tabs.filter((tab) => {
    if (tab === "agePasskey") return false;
    if (tab !== "passkey") return true;
    return (
      !!header &&
      passkeyUnlockRecords(header).some((row) =>
        allowed.includes(row.credentialIdB64),
      )
    );
  });
}
