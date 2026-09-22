import { describe, expect, it } from "vitest";
import { createIndependentCompartmentKey } from "../crypto/slots.js";
import {
  type EnrollmentState,
  createEmptyEnrollmentState,
  disposeTriggerMatch,
  enrollTrigger,
} from "../trigger/enrollment.js";
import {
  ApprovalCeremonySession,
  evaluateApprovalCeremony,
} from "./approval.js";
import {
  assertCeremonyBinding,
  assertPrfPresent,
  checkCeremonyBinding,
} from "./binding.js";
import {
  assertMayApplyLatePrfCallback,
  assertMayEnrollPrfSignInProtector,
  mayEnrollPrfSignInProtector,
  withPrfSignInGuard,
} from "./prf-guard.js";
import { CodeSubmissionBuffer } from "./submission.js";
import { createUnlockCodeSession } from "./unlock-adapter.js";

function enrolled(code = "01234567"): Promise<EnrollmentState> {
  return enrollTrigger({
    state: {
      ...createEmptyEnrollmentState({
        vaultRef: "v1",
        deviceBindingRef: "d1",
        policyRevision: 2,
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
    code,
    profileId: "approval-1",
    triggerKind: "application_code",
    plaintext: {
      compartmentKey: createIndependentCompartmentKey(),
      actionCapability: null,
      presentation: "locked",
    },
  });
}

describe("TRIGGER-F submission buffer", () => {
  it("preserves leading zeros and ignores partial / cancel", () => {
    const buf = new CodeSubmissionBuffer();
    buf.appendDigit("0");
    buf.appendDigit("1");
    buf.appendDigit("2");
    expect(buf.submitComplete()).toBeNull();
    expect(buf.peek()).toBe("");

    for (const d of "01234567") buf.appendDigit(d);
    expect(buf.status().kind).toBe("ready");
    expect(buf.peek()).toBe("01234567");
    buf.cancel();
    expect(buf.status().kind).toBe("cancelled");
    expect(buf.submitComplete()).toBeNull();
    expect(buf.status().kind).toBe("cancelled");

    for (const d of "01234567") buf.appendDigit(d);
    expect(buf.submitComplete()).toBe("01234567");
  });
});

describe("TRIGGER-D PRF sign-in guard", () => {
  it("blocks enroll and late callbacks while restricted/held", async () => {
    expect(
      mayEnrollPrfSignInProtector({
        presentation: "restricted",
        held: false,
        retiredDevice: false,
        ceremonyGeneration: 1,
        currentGeneration: 1,
      }),
    ).toBe(false);

    expect(() =>
      assertMayEnrollPrfSignInProtector({
        presentation: "normal",
        held: true,
        retiredDevice: false,
        ceremonyGeneration: 1,
        currentGeneration: 1,
      }),
    ).toThrow(/restricted\/held/);

    expect(() =>
      assertMayApplyLatePrfCallback({
        presentation: "normal",
        held: false,
        retiredDevice: false,
        ceremonyGeneration: 1,
        currentGeneration: 2,
      }),
    ).toThrow(/late PRF callback/);

    let ran = false;
    await expect(
      withPrfSignInGuard(
        {
          presentation: "decoy",
          held: false,
          retiredDevice: false,
          ceremonyGeneration: 1,
          currentGeneration: 1,
        },
        "enroll",
        async () => {
          ran = true;
          return true;
        },
      ),
    ).rejects.toThrow(/restricted\/held/);
    expect(ran).toBe(false);
  });
});

describe("TRIGGER-E approval ceremony", () => {
  it("denies before sign/mint/invoke with no fake success", async () => {
    const state = await enrolled("24681357");
    const deny = await evaluateApprovalCeremony({
      operation: "sign",
      code: "00001111",
      principalKind: "human_owner",
      state,
      expectedPolicyRevision: 2,
    });
    expect(deny.outcome).toBe("deny");
    expect(deny.fakeSuccess).toBe(false);
    expect(deny.operationAllowed).toBe(false);

    const agent = await evaluateApprovalCeremony({
      operation: "mint",
      code: "24681357",
      principalKind: "agent",
      state,
      expectedPolicyRevision: 2,
    });
    expect(agent).toMatchObject({
      outcome: "deny",
      reason: "agents_cannot_approve",
      fakeSuccess: false,
      operationAllowed: false,
    });

    const duress = await evaluateApprovalCeremony({
      operation: "invoke",
      code: "24681357",
      principalKind: "human_owner",
      state,
      expectedPolicyRevision: 2,
      approvalProfileIds: ["approval-1"],
    });
    expect(duress.outcome).toBe("duress");
    if (duress.outcome === "duress") {
      expect(duress.operationAllowed).toBe(false);
      expect(duress.fakeSuccess).toBe(false);
      disposeTriggerMatch(duress.match);
    }
  });

  it("session cancel does not count as complete submission", async () => {
    const state = await enrolled("13579135");
    const session = new ApprovalCeremonySession();
    for (const d of "13579") session.buffer.appendDigit(d);
    session.cancel();
    const result = await session.submit({
      operation: "sign",
      principalKind: "human_owner",
      state,
      expectedPolicyRevision: 2,
    });
    expect(result).toMatchObject({
      outcome: "deny",
      reason: "incomplete_submission",
      fakeSuccess: false,
    });
  });
});

describe("TRIGGER-F binding + unlock adapter", () => {
  it("rejects wrong origin/credential and missing PRF", () => {
    const wrongOrigin = checkCeremonyBinding({
      origin: "https://evil.test",
      expectedOrigin: "https://good.test",
    });
    expect(wrongOrigin.ok).toBe(false);
    if (!wrongOrigin.ok) expect(wrongOrigin.reason).toBe("wrong_origin");
    const wrongCred = checkCeremonyBinding({
      origin: "https://good.test",
      expectedOrigin: "https://good.test",
      credentialIdB64: "a",
      expectedCredentialIdB64: "b",
    });
    expect(wrongCred.ok).toBe(false);
    if (!wrongCred.ok) expect(wrongCred.reason).toBe("wrong_credential");
    expect(() =>
      assertCeremonyBinding({
        origin: "https://good.test",
        expectedOrigin: "https://good.test",
        credentialIdB64: "x",
        expectedCredentialIdB64: "y",
      }),
    ).toThrow(/wrong_credential/);
    expect(() => assertPrfPresent(null)).toThrow(/missing PRF/);
    expect(() => assertPrfPresent(new Uint8Array(8))).toThrow(/missing PRF/);
  });

  it("routes complete unlock submission with throttle gate", async () => {
    const state = await enrolled("86421357");
    const session = createUnlockCodeSession();
    for (const d of "86421357") session.buffer.appendDigit(d);
    const hit = await session.submit(state, { expectedPolicyRevision: 2 });
    expect(hit.status).toBe("matched");
    if (hit.status === "matched") disposeTriggerMatch(hit);

    // Wrong origin binding on enrolled prf profile would miss — application_code ok.
    const stale = await session.submit(
      { ...state, policyRevision: 2 },
      { expectedPolicyRevision: 9 },
    );
    // empty buffer after prior submit
    expect(stale.status).toBe("none");
  });
});
