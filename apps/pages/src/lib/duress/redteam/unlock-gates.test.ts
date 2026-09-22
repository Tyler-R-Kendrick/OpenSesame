/**
 * Unit coverage for post-match unlock continue + passkey two-input refuse.
 */

import { describe, expect, it, vi } from "vitest";
import { continueAfterDuressMatch } from "../../../screens/unlock/unlock-duress-continue.js";
import { unlockWithPasskeyAfterDuressGate } from "../../../screens/unlock/unlock-passkey-duress.js";
import { WrongPasswordError } from "../../vault/crypto.js";

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

describe("unlock duress continue", () => {
  it("opens guest for decoy presentation", async () => {
    const createGuest = vi.fn(async () => undefined);
    const cancelTotpChallenge = vi.fn();
    const result = await continueAfterDuressMatch(
      { createGuest, cancelTotpChallenge },
      continueMatch("decoy"),
      "That PIN did not unlock the vault.",
    );
    expect(result).toBe("duress_session");
    expect(createGuest).toHaveBeenCalledOnce();
    expect(cancelTotpChallenge).toHaveBeenCalledOnce();
  });

  it("looks like a wrong secret for locked presentation", async () => {
    const createGuest = vi.fn(async () => undefined);
    await expect(
      continueAfterDuressMatch(
        { createGuest },
        continueMatch("locked"),
        "That PIN did not unlock the vault.",
      ),
    ).rejects.toBeInstanceOf(WrongPasswordError);
    expect(createGuest).not.toHaveBeenCalled();
  });
});

describe("passkey duress gate", () => {
  it("allows passkey when duress is inactive", async () => {
    const unlockWithPasskey = vi.fn(async () => undefined);
    const probePasskeyPrf = vi.fn(async () => new ArrayBuffer(32));
    const unlockWithHeldPrf = vi.fn(async () => undefined);
    const createGuest = vi.fn(async () => undefined);
    await expect(
      unlockWithPasskeyAfterDuressGate({
        unlockWithPasskey,
        probePasskeyPrf,
        unlockWithHeldPrf,
        createGuest,
      }),
    ).resolves.toBe("vault_opened");
    expect(unlockWithPasskey).toHaveBeenCalledOnce();
    expect(probePasskeyPrf).not.toHaveBeenCalled();
  });
});
