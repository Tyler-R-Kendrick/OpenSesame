/**
 * Passkey unlock when duress may be armed (INV-03 / alternate wrappers).
 *
 * Application-code-only: passkey may open the ordinary root.
 * Two-input (UV+code / PRF+code): run ceremony, stash evidence, require a
 * complete code before any protected-root unwrap.
 */

import { WrongPasswordError } from "../../lib/vault/crypto.js";
import {
  loadEnrollmentStateForUnlock,
  onCompleteUnlockCodeSubmission,
} from "../../sections/settings/security/duress-unlock-bridge.js";
import {
  type DuressContinueStore,
  continueAfterDuressMatch,
} from "./unlock-duress-continue.js";
import {
  clearPasskeyDuressEvidence,
  stashPasskeyDuressEvidence,
  takePasskeyDuressEvidence,
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
  stashPasskeyDuressEvidence({
    userVerified: true,
    prfOutput: new Uint8Array(prfOutput),
    origin: globalThis.location?.origin,
  });
  return "needs_duress_code";
}

export async function completePasskeyDuressCode(
  store: PasskeyUnlockStore,
  code: string,
  options: { requireDurable?: boolean } = {},
): Promise<"vault_opened" | "duress_session"> {
  const evidence = takePasskeyDuressEvidence();
  if (evidence === null) {
    throw new WrongPasswordError("That passkey did not unlock the vault.");
  }

  const select: {
    userVerified: boolean;
    prfOutput: Uint8Array | null;
    origin?: string;
    credentialIdB64?: string;
  } = {
    userVerified: evidence.userVerified,
    prfOutput: evidence.prfOutput,
  };
  if (evidence.origin !== undefined) select.origin = evidence.origin;
  if (evidence.credentialIdB64 !== undefined) {
    select.credentialIdB64 = evidence.credentialIdB64;
  }

  const duressOutcome = await onCompleteUnlockCodeSubmission(code, {
    select,
    requireDurable: options.requireDurable ?? true,
  });

  if (
    duressOutcome.kind === "throttled" ||
    duressOutcome.kind === "ambiguous" ||
    duressOutcome.kind === "stale_policy"
  ) {
    if (select.prfOutput) {
      const restash: {
        userVerified: boolean;
        prfOutput: Uint8Array;
        origin?: string;
        credentialIdB64?: string;
      } = {
        userVerified: select.userVerified,
        prfOutput: select.prfOutput,
      };
      if (select.origin !== undefined) restash.origin = select.origin;
      if (select.credentialIdB64 !== undefined) {
        restash.credentialIdB64 = select.credentialIdB64;
      }
      stashPasskeyDuressEvidence(restash);
    }
    throw new WrongPasswordError("That PIN did not unlock the vault.");
  }

  if (duressOutcome.kind === "duress") {
    clearPasskeyDuressEvidence();
    select.prfOutput?.fill(0);
    return continueAfterDuressMatch(
      store,
      {
        profileId: duressOutcome.match.profileId,
        plaintext: duressOutcome.match.plaintext,
      },
      "That PIN did not unlock the vault.",
    );
  }

  if (!select.prfOutput) {
    throw new WrongPasswordError("That passkey did not unlock the vault.");
  }
  const held = select.prfOutput.buffer.slice(
    select.prfOutput.byteOffset,
    select.prfOutput.byteOffset + select.prfOutput.byteLength,
  );
  await store.unlockWithHeldPrf(held);
  select.prfOutput.fill(0);
  return "vault_opened";
}

export function cancelPasskeyDuressCode(): void {
  clearPasskeyDuressEvidence();
}
