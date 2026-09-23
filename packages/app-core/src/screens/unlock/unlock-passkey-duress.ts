/**
 * Passkey unlock when duress may be armed (INV-03 / alternate wrappers).
 *
 * Application-code-only: passkey may open the ordinary root.
 * Two-input (UV+code / PRF+code): run ceremony, stash evidence, require a
 * complete code before any protected-root unwrap.
 */

import { type VaultHeader, WrongPasswordError } from "@opensesame/vault-core";
import { maybePage } from "../../ports.js";
import {
  loadEnrollmentStateForUnlock,
  onCompleteUnlockCodeSubmission,
} from "../../sections/settings/security/duress-unlock-bridge.js";
import {
  type DuressContinueStore,
  continueAfterDuressMatch,
} from "./unlock-duress-continue.js";
import {
  DEFAULT_UNLOCK_DURESS_GATE_OPTIONS,
  UNLOCK_PASSKEY_MISS,
  UNLOCK_PIN_MISS,
  type UnlockDuressGateOptions,
  resolveRequireDurable,
} from "./unlock-duress-refuse.js";
import {
  clearPasskeyDuressEvidence,
  stashPasskeyDuressEvidence,
  takePasskeyDuressEvidence,
  toSelectOptions,
} from "./unlock-passkey-evidence.js";

export type PasskeyUnlockResult =
  | "vault_opened"
  | "needs_duress_code"
  | "duress_session";

type PasskeyUnlockStore = DuressContinueStore &
  Readonly<{
    unlockWithPasskey: (signal?: AbortSignal) => Promise<void>;
    probePasskeyPrf: (signal?: AbortSignal) => Promise<ArrayBuffer>;
    unlockWithHeldPrf: (prfOutput: ArrayBuffer) => Promise<void>;
    /** The unlocking vault's header: names the passkey the PRF output came from. */
    getSnapshot?: () => Readonly<{ header: VaultHeader | null }>;
  }>;

function armedTwoInputTrigger(): boolean {
  const state = loadEnrollmentStateForUnlock();
  if (!state?.armed || state.triggers.length === 0) return false;
  return state.triggers.some(
    (t) =>
      t.triggerKind === "prf_and_code" ||
      t.triggerKind === "verified_uv_then_code",
  );
}

export async function unlockWithPasskeyAfterDuressGate(
  store: PasskeyUnlockStore,
  signal?: AbortSignal,
): Promise<PasskeyUnlockResult> {
  if (!armedTwoInputTrigger()) {
    await store.unlockWithPasskey(signal);
    return "vault_opened";
  }

  const prfOutput = await store.probePasskeyPrf(signal);
  // The ceremony asks for the header's own passkey, so its credential id is
  // the one a prf_and_code trigger's binding is checked against.
  const passkey = store.getSnapshot?.().header?.unlocks?.passkey;
  stashPasskeyDuressEvidence(
    toSelectOptions({
      userVerified: true,
      prfOutput: new Uint8Array(prfOutput),
      origin: maybePage()?.location.origin,
      credentialIdB64: passkey?.credentialIdB64,
    }),
  );
  return "needs_duress_code";
}

export async function completePasskeyDuressCode(
  store: PasskeyUnlockStore,
  code: string,
  options: UnlockDuressGateOptions = DEFAULT_UNLOCK_DURESS_GATE_OPTIONS,
): Promise<"vault_opened" | "duress_session"> {
  const evidence = takePasskeyDuressEvidence();
  if (evidence === null) {
    throw new WrongPasswordError(UNLOCK_PASSKEY_MISS);
  }

  const select = toSelectOptions(evidence);
  const duressOutcome = await onCompleteUnlockCodeSubmission(code, {
    select,
    requireDurable: resolveRequireDurable(options),
  });

  if (duressOutcome.kind === "duress") {
    clearPasskeyDuressEvidence();
    select.prfOutput?.fill(0);
    return continueAfterDuressMatch(
      store,
      {
        profileId: duressOutcome.match.profileId,
        plaintext: duressOutcome.match.plaintext,
      },
      UNLOCK_PIN_MISS,
    );
  }

  if (duressOutcome.kind === "inactive" || duressOutcome.kind === "normal") {
    if (!select.prfOutput) {
      throw new WrongPasswordError(UNLOCK_PASSKEY_MISS);
    }
    const held = select.prfOutput.buffer.slice(
      select.prfOutput.byteOffset,
      select.prfOutput.byteOffset + select.prfOutput.byteLength,
    );
    await store.unlockWithHeldPrf(held);
    select.prfOutput.fill(0);
    return "vault_opened";
  }

  if (select.prfOutput) stashPasskeyDuressEvidence(select);
  throw new WrongPasswordError(UNLOCK_PIN_MISS);
}

export function cancelPasskeyDuressCode(): void {
  clearPasskeyDuressEvidence();
}
