/**
 * A `prf_and_code` duress trigger is bound to one passkey's PRF output
 * (ADR 0152, INV-03). Against the real duress runtime: a road that cannot carry
 * that output — an age passkey, or a passkey capsule's other credential — never
 * opens the vault silently past a typed duress code.
 */

import { overlapCast } from "@opensesame/os-domain";
import { type VaultHeader, WrongPasswordError } from "@opensesame/vault-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { configureHost } from "../../host.js";
import { createIndependentCompartmentKey } from "../../lib/duress/crypto/slots.js";
import { duressSessionFence } from "../../lib/duress/session/fence.js";
import { disarmPersistedUnlockEnrollment } from "../../lib/duress/settings/unlock-arming.js";
import {
  clearEnrollmentStateForUnlock,
  persistEnrollmentStateForUnlock,
} from "../../lib/duress/store/unlock-enrollment.js";
import {
  createEmptyEnrollmentState,
  enrollTrigger,
} from "../../lib/duress/trigger/enrollment.js";
import { createTestHost } from "../../test-host.js";
import {
  completePasskeyDuressCode,
  unlockWithPasskeyAfterDuressGate,
} from "./unlock-passkey-duress.js";
import {
  clearPasskeyDuressEvidence,
  hasHeldProtectorRoot,
  holdProtectorRoot,
  peekPasskeyDuressEvidence,
  stashPasskeyDuressEvidence,
} from "./unlock-passkey-evidence.js";
import {
  credentialsCarryingArmedPrf,
  tabsThatCarryArmedPrf,
} from "./unlock-prf-trigger.js";
import { unlockWithProtectorAfterDuressGate } from "./unlock-protector-duress.js";

const ORIGIN = "https://vault.test";
const BOUND = "Ym91bmQtY3JlZGVudGlhbA==";
const OTHER = "b3RoZXItY3JlZGVudGlhbA==";
const DURESS_CODE = "24681357";
const OPTIONS = { requireDurable: false };
const PRF = crypto.getRandomValues(new Uint8Array(32));

function prfBuffer(): ArrayBuffer {
  return PRF.slice().buffer;
}

function resetFence(): void {
  const ids = [...duressSessionFence.readFence().activeIncidentIds];
  if (ids.length > 0) duressSessionFence.resolve(ids, true);
}

/** Arm the real runtime with a prf_and_code trigger bound to BOUND at ORIGIN. */
async function armPrfAndCode(credentialIdB64 = BOUND): Promise<void> {
  const state = await enrollTrigger({
    state: {
      ...createEmptyEnrollmentState({
        vaultRef: "vault-prf",
        deviceBindingRef: "device-prf",
        policyRevision: 1,
        keyEpoch: 1,
        capabilities: {
          durableLocalStorage: true,
          prfAvailable: true,
          userVerificationAvailable: true,
          offlineReady: true,
        },
      }),
      ownerConsent: true,
    },
    code: DURESS_CODE,
    profileId: "p-prf",
    triggerKind: "prf_and_code",
    plaintext: {
      compartmentKey: createIndependentCompartmentKey(),
      actionCapability: null,
      presentation: "restricted",
    },
    credentialIdB64,
    expectedOrigin: ORIGIN,
    prfOutput: PRF,
  });
  await persistEnrollmentStateForUnlock({ ...state, armed: true }, OPTIONS);
}

function store(answeredBy = BOUND) {
  return {
    unlockWithProtector: vi.fn(async () => undefined),
    probeProtector: vi.fn(async () => new Uint8Array(32).fill(9).buffer),
    unlockWithHeldProtectorRoot: vi.fn(async () => undefined),
    unlockWithPasskey: vi.fn(async () => undefined),
    probePasskeyCeremony: vi.fn(
      async (_options?: { onlyCredentialIds?: readonly string[] }) => ({
        prfOutput: prfBuffer(),
        credentialIdB64: answeredBy,
      }),
    ),
    unlockWithHeldPrf: vi.fn(async () => undefined),
    createGuest: vi.fn(async () => undefined),
    cancelTotpChallenge: vi.fn(),
  };
}

beforeEach(async () => {
  configureHost(
    createTestHost({
      page: overlapCast({
        location: { origin: ORIGIN, href: `${ORIGIN}/` },
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }),
    }),
  );
  await disarmPersistedUnlockEnrollment();
  clearEnrollmentStateForUnlock();
  clearPasskeyDuressEvidence();
  resetFence();
});

describe("the passkey road with a prf_and_code trigger armed", () => {
  it("offers only the bound credential and opens the decoy on the duress code", async () => {
    await armPrfAndCode();
    const s = store();
    await expect(
      unlockWithPasskeyAfterDuressGate(s as never),
    ).resolves.toBe("needs_duress_code");
    expect(s.probePasskeyCeremony).toHaveBeenCalledWith({
      onlyCredentialIds: [BOUND],
    });
    expect(peekPasskeyDuressEvidence()?.credentialIdB64).toBe(BOUND);

    await expect(
      completePasskeyDuressCode(s as never, DURESS_CODE, OPTIONS),
    ).resolves.toBe("duress_session");
    expect(s.createGuest).toHaveBeenCalledOnce();
    expect(s.unlockWithHeldPrf).not.toHaveBeenCalled();
  });

  it("still opens the vault for a code that is not the duress code", async () => {
    await armPrfAndCode();
    const s = store();
    await unlockWithPasskeyAfterDuressGate(s as never);
    await expect(
      completePasskeyDuressCode(s as never, "99887766", OPTIONS),
    ).resolves.toBe("vault_opened");
    expect(s.unlockWithHeldPrf).toHaveBeenCalledOnce();
  });

  it("refuses a capsule credential other than the bound one, whatever the store answered", async () => {
    await armPrfAndCode();
    const s = store(OTHER);
    await expect(
      unlockWithPasskeyAfterDuressGate(s as never),
    ).rejects.toBeInstanceOf(WrongPasswordError);
    expect(peekPasskeyDuressEvidence()).toBeNull();
    expect(s.unlockWithHeldPrf).not.toHaveBeenCalled();
  });

  it("opens nothing when evidence from another credential reaches the code", async () => {
    await armPrfAndCode();
    // The evidence names the credential that actually answered; a typed
    // duress code beside it cannot be tried against the trigger.
    stashPasskeyDuressEvidence({
      userVerified: true,
      prfOutput: PRF.slice(),
      origin: ORIGIN,
      credentialIdB64: OTHER,
    });
    const s = store();
    await expect(
      completePasskeyDuressCode(s as never, DURESS_CODE, OPTIONS),
    ).rejects.toBeInstanceOf(WrongPasswordError);
    expect(s.unlockWithHeldPrf).not.toHaveBeenCalled();
    expect(s.createGuest).not.toHaveBeenCalled();
    expect(peekPasskeyDuressEvidence()).toBeNull();
  });

  it("is withheld from the tabs when no credential of the vault is the bound one", async () => {
    await armPrfAndCode();
    expect(credentialsCarryingArmedPrf()).toEqual([BOUND]);
    const header: VaultHeader = overlapCast({
      unlocks: { passkey: { credentialIdB64: OTHER } },
    });
    expect(
      tabsThatCarryArmedPrf(["passkey", "agePasskey", "recovery"], header),
    ).toEqual(["recovery"]);
    const boundHeader: VaultHeader = overlapCast({
      unlocks: { passkey: { credentialIdB64: BOUND } },
    });
    expect(
      tabsThatCarryArmedPrf(["passkey", "agePasskey", "recovery"], boundHeader),
    ).toEqual(["passkey", "recovery"]);
  });
});

describe("the age passkey with a prf_and_code trigger armed", () => {
  const input = { method: "agePasskey" } as const;

  it("is refused before any ceremony runs", async () => {
    await armPrfAndCode();
    const s = store();
    await expect(
      unlockWithProtectorAfterDuressGate(s, input, OPTIONS),
    ).rejects.toBeInstanceOf(WrongPasswordError);
    expect(s.probeProtector).not.toHaveBeenCalled();
    expect(s.unlockWithProtector).not.toHaveBeenCalled();
    expect(hasHeldProtectorRoot()).toBe(false);
  });

  it("opens nothing when a held root reaches a code the trigger could not be tried against", async () => {
    await armPrfAndCode();
    holdProtectorRoot(new Uint8Array(32).fill(9).buffer, "agePasskey");
    stashPasskeyDuressEvidence({
      userVerified: true,
      prfOutput: null,
      origin: ORIGIN,
    });
    const s = store();
    await expect(
      completePasskeyDuressCode(s as never, DURESS_CODE, OPTIONS),
    ).rejects.toBeInstanceOf(WrongPasswordError);
    expect(s.unlockWithHeldProtectorRoot).not.toHaveBeenCalled();
    expect(hasHeldProtectorRoot()).toBe(false);
  });

  it("is absent from the tabs while the trigger is armed, and back when it is not", async () => {
    const header: VaultHeader = overlapCast({});
    expect(tabsThatCarryArmedPrf(["agePasskey", "age"], header)).toEqual([
      "agePasskey",
      "age",
    ]);
    await armPrfAndCode();
    expect(tabsThatCarryArmedPrf(["agePasskey", "age"], header)).toEqual([
      "age",
    ]);
  });
});
