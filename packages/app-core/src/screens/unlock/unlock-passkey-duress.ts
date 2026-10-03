/**
 * Passkey unlock when duress may be armed (INV-03 / alternate wrappers).
 *
 * Application-code-only: passkey may open the ordinary root.
 * Two-input (UV+code / PRF+code): run ceremony, stash evidence, require a
 * complete code before any protected-root unwrap.
 */

import { WrongPasswordError } from "@opensesame/vault-core";
import type { ProtectorUnlockInput } from "../../lib/vault/protection/unlock-protector-open.js";
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
  type UnlockDuressGateOptions,
  resolveRequireDurable,
} from "./unlock-duress-refuse.js";
import {
  clearHeldProtectorRoot,
  clearPasskeyDuressEvidence,
  hasHeldProtectorRoot,
  holdProtectorRoot,
  stashPasskeyDuressEvidence,
  takeHeldProtectorRoot,
  takePasskeyDuressEvidence,
  toSelectOptions,
} from "./unlock-passkey-evidence.js";
import {
  credentialsCarryingArmedPrf,
  evidenceCarriesArmedPrf,
} from "./unlock-prf-trigger.js";

export type PasskeyUnlockResult =
  | "vault_opened"
  | "needs_duress_code"
  | "duress_session";

type PasskeyUnlockStore = DuressContinueStore &
  Readonly<{
    unlockWithPasskey: (signal?: AbortSignal) => Promise<void>;
    probePasskeyCeremony: (options?: {
      signal?: AbortSignal;
      onlyCredentialIds?: readonly string[];
    }) => Promise<
      Readonly<{ prfOutput: ArrayBuffer; credentialIdB64: string }>
    >;
    unlockWithHeldPrf: (prfOutput: ArrayBuffer) => Promise<void>;
    unlockWithHeldProtectorRoot?: (
      root: ArrayBuffer,
      input: Pick<ProtectorUnlockInput, "method">,
    ) => Promise<void>;
  }>;

export function armedTwoInputTrigger(): boolean {
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

  // An armed prf_and_code trigger is bound to one credential: only that one is
  // offered, since another credential's PRF output cannot carry it.
  const only = credentialsCarryingArmedPrf();
  const probe = await store.probePasskeyCeremony({
    ...(signal ? { signal } : {}),
    ...(only ? { onlyCredentialIds: only } : {}),
  });
  const prfOutput = new Uint8Array(probe.prfOutput);
  try {
    if (only && !only.includes(probe.credentialIdB64)) {
      throw new WrongPasswordError(UNLOCK_PASSKEY_MISS);
    }
    // The credential that answered, not the header's first: it is the one a
    // prf_and_code trigger's binding is checked against.
    stashPasskeyDuressEvidence(
      toSelectOptions({
        userVerified: true,
        prfOutput,
        origin: maybePage()?.location.origin,
        credentialIdB64: probe.credentialIdB64,
      }),
    );
  } finally {
    // The stash holds its own copy.
    prfOutput.fill(0);
  }
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
      UNLOCK_PASSKEY_MISS,
    );
  }

  if (duressOutcome.kind === "inactive" || duressOutcome.kind === "normal") {
    if (!evidenceCarriesArmedPrf(select)) {
      // A typed code that no trigger could be tried against is not an ordinary
      // code: opening the vault here would ignore a duress code silently.
      select.prfOutput?.fill(0);
      clearHeldProtectorRoot();
      throw new WrongPasswordError(UNLOCK_PASSKEY_MISS);
    }
    if (!select.prfOutput) {
      // An age-passkey tap carries no PRF output: it holds the root it opened.
      const root = takeHeldProtectorRoot();
      if (!root || !store.unlockWithHeldProtectorRoot) {
        throw new WrongPasswordError(UNLOCK_PASSKEY_MISS);
      }
      try {
        await store.unlockWithHeldProtectorRoot(root.root, root);
      } catch (error) {
        holdProtectorRoot(root.root, root.method);
        stashPasskeyDuressEvidence(select);
        throw error;
      }
      new Uint8Array(root.root).fill(0);
      return "vault_opened";
    }
    const held = select.prfOutput.buffer.slice(
      select.prfOutput.byteOffset,
      select.prfOutput.byteOffset + select.prfOutput.byteLength,
    );
    await store.unlockWithHeldPrf(held);
    select.prfOutput.fill(0);
    return "vault_opened";
  }

  if (select.prfOutput || hasHeldProtectorRoot()) {
    stashPasskeyDuressEvidence(select);
  }
  throw new WrongPasswordError(UNLOCK_PASSKEY_MISS);
}

export function cancelPasskeyDuressCode(): void {
  clearPasskeyDuressEvidence();
}
