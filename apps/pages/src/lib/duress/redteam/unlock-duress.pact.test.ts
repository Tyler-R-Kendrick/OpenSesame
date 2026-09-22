/**
 * PACT — Property / Adversarial / Chaos / conTract for duress unlock gates.
 * Clocks are always injected — never sleep for lockoutMs (INV-25).
 */

import { describe, expect, it, vi } from "vitest";
import { continueAfterDuressMatch } from "../../../screens/unlock/unlock-duress-continue.js";
import { WrongPasswordError } from "../../vault/crypto.js";
import { TriggerAttemptPolicy } from "../trigger/attempt-policy.js";

describe("PACT — duress unlock", () => {
  it("property: throttle uses injected clocks, never wall time", () => {
    const policy = new TriggerAttemptPolicy({
      maxFailures: 3,
      windowMs: 60_000,
      lockoutMs: 30_000,
    });
    const t0 = 1_000_000;
    policy.recordCompleteMiss(t0);
    policy.recordCompleteMiss(t0 + 1);
    policy.recordCompleteMiss(t0 + 2);
    expect(policy.beginCompleteAttempt(t0 + 3).allowed).toBe(false);
    expect(policy.isThrottled(t0 + 3)).toBe(true);
    expect(policy.isThrottled(t0 + 2 + 29_999)).toBe(true);
    expect(policy.isThrottled(t0 + 2 + 30_000)).toBe(false);
    expect(policy.beginCompleteAttempt(t0 + 2 + 30_000).allowed).toBe(true);
    expect(policy.wouldAutoTriggerFromAttemptCount()).toBe(false);
  });

  it("adversarial: locked presentation never calls createGuest", async () => {
    const createGuest = vi.fn(async () => undefined);
    await expect(
      continueAfterDuressMatch(
        { createGuest },
        "locked",
        "That PIN did not unlock the vault.",
      ),
    ).rejects.toBeInstanceOf(WrongPasswordError);
    expect(createGuest).not.toHaveBeenCalled();
  });

  it("chaos: concurrent continue into guest does not throw or drop work", async () => {
    const createGuest = vi.fn(async () => undefined);
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        continueAfterDuressMatch(
          { createGuest },
          "decoy",
          "That PIN did not unlock the vault.",
        ),
      ),
    );
    expect(results.every((r) => r === "duress_session")).toBe(true);
    expect(createGuest).toHaveBeenCalledTimes(8);
  });

  it("contract: open presentations always request createGuest", async () => {
    for (const presentation of ["normal", "restricted", "decoy"] as const) {
      const createGuest = vi.fn(async () => undefined);
      await continueAfterDuressMatch(
        { createGuest },
        presentation,
        "That PIN did not unlock the vault.",
      );
      expect(createGuest, presentation).toHaveBeenCalledOnce();
    }
  });
});
