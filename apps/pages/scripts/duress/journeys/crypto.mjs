/**
 * Real-browser slot seal/open + PRF-and-code (simulated PRF bytes).
 * Uses production duress crypto modules via fixture — INV-05/INV-08.
 */
const CODE = "48291037";

export async function walkCryptoSlot({ page, check }) {
  const result = await page.evaluate(async (code) => {
    const qa = window.__duressQa;
    const compartmentKey = qa.createIndependentCompartmentKey();
    const slot = await qa.sealProfileSlot({
      code,
      slotId: "slot-1",
      profileId: "SC-ALERT-ONLY",
      vaultRef: "vault-qa",
      deviceBindingRef: "device-qa",
      policyRevision: 1,
      keyEpoch: 1,
      plaintext: {
        compartmentKey,
        actionCapability: null,
        presentation: "restricted",
      },
    });
    const opened = await qa.openProfileSlot(code, slot, {
      vaultRef: "vault-qa",
      deviceBindingRef: "device-qa",
      policyRevision: 1,
      keyEpoch: 1,
    });
    const wrong = await qa.openProfileSlot("99999999", slot, {
      vaultRef: "vault-qa",
      deviceBindingRef: "device-qa",
      policyRevision: 1,
      keyEpoch: 1,
    });
    const stale = await qa.openProfileSlot(code, slot, {
      vaultRef: "vault-qa",
      deviceBindingRef: "device-qa",
      policyRevision: 2,
      keyEpoch: 1,
    });
    return {
      iterations: slot.iterations,
      openedPresentation: opened?.presentation ?? null,
      openedKeyLen: opened?.compartmentKey?.length ?? 0,
      wrongIsNull: wrong === null,
      staleIsNull: stale === null,
      floor: qa.DURESS_PIN_PBKDF2_ITERATIONS,
    };
  }, CODE);

  check(
    result.iterations >= result.floor,
    `PBKDF2 iterations at/above floor (${result.iterations})`,
  );
  check(result.openedPresentation === "restricted", "correct code opens slot");
  check(result.openedKeyLen === 32, "compartment key is 32 bytes");
  check(result.wrongIsNull, "wrong code returns null");
  check(result.staleIsNull, "stale policy revision returns null");
  return result;
}

export async function walkPrfAndCode({ page, check }) {
  const result = await page.evaluate(async (code) => {
    const qa = window.__duressQa;
    const compartmentKey = qa.createIndependentCompartmentKey();
    const prf = qa.fakePrfOutput(32);
    const envelope = await qa.sealPrfAndCode({
      prfOutput: prf,
      code,
      compartmentKey,
      profileId: "SC-RESTRICTED",
      vaultRef: "vault-qa",
      policyRevision: 1,
      keyEpoch: 1,
    });
    const both = await qa.openPrfAndCode({
      prfOutput: prf,
      code,
      envelope,
    });
    const prfOnly = await qa.openPrfAndCode({
      prfOutput: prf,
      code: null,
      envelope,
    });
    const codeOnly = await qa.openPrfAndCode({
      prfOutput: null,
      code,
      envelope,
    });
    const wrongPrf = await qa.openPrfAndCode({
      prfOutput: qa.fakePrfOutput(32),
      code,
      envelope,
    });
    return {
      bothLen: both?.length ?? 0,
      prfOnlyNull: prfOnly === null,
      codeOnlyNull: codeOnly === null,
      wrongPrfNull: wrongPrf === null,
      note: "PRF bytes are simulated — not hardware authenticator PRF",
    };
  }, CODE);

  check(result.bothLen === 32, "PRF+code opens compartment key");
  check(result.prfOnlyNull, "PRF alone fails closed");
  check(result.codeOnlyNull, "code alone fails closed");
  check(result.wrongPrfNull, "wrong PRF fails closed");
  return result;
}

export async function walkTrigger({ page, check }) {
  const result = await page.evaluate(async (code) => {
    const qa = window.__duressQa;
    let state = qa.createEmptyEnrollmentState({
      vaultRef: "vault-qa",
      deviceBindingRef: "device-qa",
      policyRevision: 1,
      keyEpoch: 1,
    });
    state = { ...state, ownerConsent: true, rehearsalPassed: true };
    state = await qa.enrollTrigger({
      state,
      code,
      profileId: "SC-DECOY",
      triggerKind: "application_code",
      plaintext: {
        compartmentKey: qa.createIndependentCompartmentKey(),
        actionCapability: null,
        presentation: "decoy",
      },
    });
    const matched = await qa.selectTrigger(code, state);
    const none = await qa.selectTrigger("11111111", state);
    const short = await qa.selectTrigger("123", state);
    let ambiguousErr = null;
    try {
      await qa.enrollTrigger({
        state,
        code,
        profileId: "other",
        triggerKind: "application_code",
        plaintext: {
          compartmentKey: qa.createIndependentCompartmentKey(),
          actionCapability: null,
          presentation: "normal",
        },
      });
    } catch (error) {
      ambiguousErr = String(error?.message ?? error);
    }
    return {
      matchedStatus: matched.status,
      matchedProfile: matched.status === "matched" ? matched.profileId : null,
      noneStatus: none.status,
      shortStatus: short.status,
      ambiguousErr,
      armed: state.armed === true,
    };
  }, CODE);

  check(
    result.matchedStatus === "matched",
    "complete code selects one trigger",
  );
  check(result.matchedProfile === "SC-DECOY", "matched profile is enrolled id");
  check(result.noneStatus === "none", "unknown complete code → none");
  check(result.shortStatus === "none", "short input never selects (INV-03)");
  check(
    /ambiguous_trigger/.test(result.ambiguousErr ?? ""),
    "duplicate code enrollment fails closed",
  );
  check(result.armed === true, "enrollment arms after rehearsed commit");
  return result;
}
