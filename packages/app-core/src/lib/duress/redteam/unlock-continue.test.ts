/**
 * Unit coverage for post-match unlock continue (INV-03 / INV-05).
 */

import type { BoundaryValue } from "@opensesame/os-domain";
import { WrongPasswordError } from "@opensesame/vault-core";
import { describe, expect, it, vi } from "vitest";
import {
  continueAfterDuressMatch,
  resolveDuressPresentation,
} from "../../../screens/unlock/unlock-duress-continue.js";
import { UNLOCK_PIN_MISS } from "../../../screens/unlock/unlock-duress-refuse.js";

function continueMatch(presentation: string, profileId = "p-test") {
  return {
    profileId,
    plaintext: {
      compartmentKey: crypto.getRandomValues(new Uint8Array(32)),
      actionCapability: null,
      presentation,
    },
  };
}

describe("resolveDuressPresentation", () => {
  it("keeps every closed presentation class", () => {
    for (const value of [
      "normal",
      "restricted",
      "decoy",
      "locked",
      "unchanged",
    ] as const) {
      expect(resolveDuressPresentation(value)).toBe(value);
    }
  });

  it("maps unknown values to restricted", () => {
    expect(resolveDuressPresentation("not-a-real-class")).toBe("restricted");
    expect(resolveDuressPresentation("")).toBe("restricted");
  });
});

describe("unlock duress continue", () => {
  it("opens guest for decoy presentation", async () => {
    const createGuest = vi.fn(async () => undefined);
    const cancelTotpChallenge = vi.fn();
    const match = continueMatch("decoy");
    const result = await continueAfterDuressMatch(
      { createGuest, cancelTotpChallenge },
      match,
      UNLOCK_PIN_MISS,
    );
    expect(result).toBe("duress_session");
    expect(createGuest).toHaveBeenCalledOnce();
    expect(cancelTotpChallenge).toHaveBeenCalledOnce();
    expect([...match.plaintext.compartmentKey]).toEqual(Array(32).fill(0));
  });

  it("looks like a wrong secret for locked presentation", async () => {
    const createGuest = vi.fn(async () => undefined);
    const match = continueMatch("locked");
    match.plaintext.compartmentKey.fill(7);
    await expect(
      continueAfterDuressMatch({ createGuest }, match, UNLOCK_PIN_MISS),
    ).rejects.toSatisfy(
      (err: BoundaryValue) =>
        err instanceof WrongPasswordError && err.message === UNLOCK_PIN_MISS,
    );
    expect(createGuest).not.toHaveBeenCalled();
    expect([...match.plaintext.compartmentKey]).toEqual(Array(32).fill(0));
  });

  it("mints admitted keys with default compartment ref and epoch", async () => {
    const { readActivePresentation, clearActivePresentation } = await import(
      "../compartment/presentation-runtime.js"
    );
    clearActivePresentation();
    const createGuest = vi.fn(async () => undefined);
    await continueAfterDuressMatch(
      { createGuest },
      continueMatch("decoy", "p-mint"),
      UNLOCK_PIN_MISS,
    );
    const active = readActivePresentation();
    expect(active?.profileId).toBe("p-mint");
    expect(active?.outcome.session.contextId).toMatch(/^duress:p-mint:/);
    expect(active?.outcome.session.admitted).toHaveLength(1);
    expect(active?.outcome.session.admitted[0]?.compartmentRef).toBe(
      "compartment:p-mint",
    );
    expect(active?.outcome.session.admitted[0]?.keyEpoch).toBe(1);
    expect(active?.outcome.session.suppressSensitiveLabels).toBe(true);
  });
});

it("sets presentation runtime for decoy and clears on locked", async () => {
  const { readActivePresentation, clearActivePresentation } = await import(
    "../compartment/presentation-runtime.js"
  );
  clearActivePresentation();
  const createGuest = vi.fn(async () => undefined);
  await continueAfterDuressMatch(
    { createGuest },
    continueMatch("decoy", "p-decoy"),
    UNLOCK_PIN_MISS,
  );
  const active = readActivePresentation();
  expect(active?.profileId).toBe("p-decoy");
  expect(active?.outcome.kind).toBe("locked");
  expect(active?.view.locked).toBe(true);

  await expect(
    continueAfterDuressMatch(
      { createGuest },
      continueMatch("locked"),
      UNLOCK_PIN_MISS,
    ),
  ).rejects.toBeInstanceOf(WrongPasswordError);
  expect(readActivePresentation()).toBeNull();
});

it("treats unchanged like a wrong secret", async () => {
  const createGuest = vi.fn(async () => undefined);
  await expect(
    continueAfterDuressMatch(
      { createGuest },
      continueMatch("unchanged"),
      UNLOCK_PIN_MISS,
    ),
  ).rejects.toBeInstanceOf(WrongPasswordError);
  expect(createGuest).not.toHaveBeenCalled();
});

it("opens guest for normal and restricted presentations", async () => {
  const { readActivePresentation, clearActivePresentation } = await import(
    "../compartment/presentation-runtime.js"
  );
  for (const presentation of ["normal", "restricted"] as const) {
    clearActivePresentation();
    const createGuest = vi.fn(async () => undefined);
    await expect(
      continueAfterDuressMatch(
        { createGuest },
        continueMatch(presentation),
        UNLOCK_PIN_MISS,
      ),
    ).resolves.toBe("duress_session");
    expect(createGuest, presentation).toHaveBeenCalledOnce();
    expect(
      readActivePresentation()?.outcome.session.suppressSensitiveLabels,
      presentation,
    ).toBe(presentation !== "normal");
  }
});

it("unknown presentation maps to restricted guest continue", async () => {
  const { readActivePresentation, clearActivePresentation } = await import(
    "../compartment/presentation-runtime.js"
  );
  clearActivePresentation();
  const createGuest = vi.fn(async () => undefined);
  await expect(
    continueAfterDuressMatch(
      { createGuest },
      continueMatch("not-a-real-class"),
      UNLOCK_PIN_MISS,
    ),
  ).resolves.toBe("duress_session");
  expect(createGuest).toHaveBeenCalledOnce();
  expect(
    readActivePresentation()?.outcome.session.suppressSensitiveLabels,
  ).toBe(true);
});
