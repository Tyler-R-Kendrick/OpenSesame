/**
 * Unit coverage for post-match unlock continue seams (INV-03 / INV-05).
 */

import { describe, expect, it, vi } from "vitest";
import {
  continueAfterDuressMatch,
  resolveDuressPresentation,
} from "../../../screens/unlock/unlock-duress-continue.js";
import { WrongPasswordError } from "../../vault/crypto.js";
import type { PublishedCompartment } from "../compartment/registry.js";
import type { PresentationSession } from "../compartment/session.js";

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

function stubSession(
  presentation: PresentationSession["presentation"],
): PresentationSession {
  return {
    presentation,
    profileId: "p-test",
    admitted: Object.freeze([]),
    contextId: "ctx",
    suppressSensitiveLabels:
      presentation === "decoy" || presentation === "restricted",
  };
}

function stubLockedOpen(session: PresentationSession) {
  return {
    kind: "locked" as const,
    reason: "missing_decoy" as const,
    session: { ...session, presentation: "locked" as const },
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
      "That PIN did not unlock the vault.",
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
      continueAfterDuressMatch(
        { createGuest },
        match,
        "That PIN did not unlock the vault.",
      ),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof WrongPasswordError &&
        err.message === "That PIN did not unlock the vault.",
    );
    expect(createGuest).not.toHaveBeenCalled();
    expect([...match.plaintext.compartmentKey]).toEqual(Array(32).fill(0));
  });

  it("mints admitted keys with default compartment ref and epoch", async () => {
    const createGuest = vi.fn(async () => undefined);
    const mint = vi.fn(async (input) => stubSession(input.presentation));
    const open = vi.fn(
      async (
        session: PresentationSession,
        _published: PublishedCompartment | null | undefined,
      ) => stubLockedOpen(session),
    );
    await continueAfterDuressMatch(
      { createGuest },
      continueMatch("decoy", "p-mint"),
      "That PIN did not unlock the vault.",
      { mintPresentationSession: mint, openPresentation: open },
    );
    expect(mint).toHaveBeenCalledOnce();
    const input = mint.mock.calls[0]?.[0];
    expect(input.presentation).toBe("decoy");
    expect(input.profileId).toBe("p-mint");
    expect(input.contextId).toMatch(/^duress:p-mint:/);
    expect(input.contextId.length).toBeGreaterThan("duress:p-mint:".length);
    expect(input.admittedKeys).toHaveLength(1);
    expect(input.admittedKeys[0]?.compartmentRef).toBe("compartment:p-mint");
    expect(input.admittedKeys[0]?.keyEpoch).toBe(1);
    expect(open).toHaveBeenCalledOnce();
    expect(open.mock.calls[0]?.[1]).toBeNull();
  });

  it("forwards explicit compartment ref, epoch, and published blob", async () => {
    const createGuest = vi.fn(async () => undefined);
    const published: PublishedCompartment = {
      compartmentRef: "c-explicit",
      kind: "decoy",
      keyEpoch: 9,
      independentRoot: true,
      sealed: {
        version: 1,
        compartmentRef: "c-explicit",
        keyEpoch: 9,
        ivB64: "AAAAAAAAAAAA",
        ctB64: "AAAAAAAAAAAAAAAAAAAAAA==",
      },
      rawKey: new Uint8Array(32),
    };
    const mint = vi.fn(async (input) => stubSession(input.presentation));
    const open = vi.fn(
      async (
        session: PresentationSession,
        _published: PublishedCompartment | null | undefined,
      ) => stubLockedOpen(session),
    );
    await continueAfterDuressMatch(
      { createGuest },
      {
        ...continueMatch("restricted", "p-fwd"),
        compartmentRef: "c-explicit",
        keyEpoch: 9,
        published,
      },
      "That PIN did not unlock the vault.",
      { mintPresentationSession: mint, openPresentation: open },
    );
    const input = mint.mock.calls[0]?.[0];
    expect(input.presentation).toBe("restricted");
    expect(input.admittedKeys[0]?.compartmentRef).toBe("c-explicit");
    expect(input.admittedKeys[0]?.keyEpoch).toBe(9);
    expect(open.mock.calls[0]?.[1]).toBe(published);
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
    "That PIN did not unlock the vault.",
  );
  const active = readActivePresentation();
  expect(active?.profileId).toBe("p-decoy");
  expect(active?.outcome.kind).toBe("locked");
  expect(active?.view.locked).toBe(true);

  await expect(
    continueAfterDuressMatch(
      { createGuest },
      continueMatch("locked"),
      "That PIN did not unlock the vault.",
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
      "That PIN did not unlock the vault.",
    ),
  ).rejects.toBeInstanceOf(WrongPasswordError);
  expect(createGuest).not.toHaveBeenCalled();
});

it("opens guest for normal and restricted presentations", async () => {
  for (const presentation of ["normal", "restricted"] as const) {
    const createGuest = vi.fn(async () => undefined);
    await expect(
      continueAfterDuressMatch(
        { createGuest },
        continueMatch(presentation),
        "That PIN did not unlock the vault.",
      ),
    ).resolves.toBe("duress_session");
    expect(createGuest, presentation).toHaveBeenCalledOnce();
  }
});

it("unknown presentation maps to restricted guest continue", async () => {
  const createGuest = vi.fn(async () => undefined);
  const mint = vi.fn(async (input) => stubSession(input.presentation));
  const open = vi.fn(
    async (
      session: PresentationSession,
      _published: PublishedCompartment | null | undefined,
    ) => stubLockedOpen(session),
  );
  await expect(
    continueAfterDuressMatch(
      { createGuest },
      continueMatch("not-a-real-class"),
      "That PIN did not unlock the vault.",
      { mintPresentationSession: mint, openPresentation: open },
    ),
  ).resolves.toBe("duress_session");
  expect(mint.mock.calls[0]?.[0].presentation).toBe("restricted");
  expect(createGuest).toHaveBeenCalledOnce();
});
