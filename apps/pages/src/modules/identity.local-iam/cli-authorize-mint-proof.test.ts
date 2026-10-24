import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cliAuthorizeMintSeams,
  mintCliAuthorizePinProof,
} from "./cli-authorize-mint-proof.js";

const seams = { ...cliAuthorizeMintSeams };

describe("CLI PIN approval", () => {
  afterEach(() => {
    Object.assign(cliAuthorizeMintSeams, seams);
    vi.unstubAllGlobals();
  });

  it("refuses a PIN without asking the passkey authenticator", async () => {
    cliAuthorizeMintSeams.duressCheck = async () => ({ kind: "normal" });
    cliAuthorizeMintSeams.unwrapPin = async () => new Uint8Array(32);
    cliAuthorizeMintSeams.pairingSecret = () => "A".repeat(43);
    const get = vi.fn();
    vi.stubGlobal("navigator", {
      credentials: { get, create: vi.fn() },
    });
    const row = ["req", "term", "read", "nonce", "daemon", "00", 0, 0] as const;
    await expect(
      // SAFETY: the unwrapPin seam above never reads the header, so an empty fixture matches everything this path uses.
      mintCliAuthorizePinProof(row, "1234", {} as never),
    ).rejects.toMatchObject({
      code: "pin_not_accepted",
      message:
        "A PIN cannot approve a CLI request. Use the passkey from pairing.",
    });
    expect(get).not.toHaveBeenCalled();
  });
});
