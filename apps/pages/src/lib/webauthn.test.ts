import { describe, expect, it } from "vitest";
import { detectWebAuthn } from "./webauthn.js";

describe("detectWebAuthn", () => {
  it("reports missing when the credentials API is absent", async () => {
    await expect(detectWebAuthn(null)).resolves.toBe("missing");
  });

  it("reports ok when a platform authenticator is available", async () => {
    await expect(
      detectWebAuthn({
        isUserVerifyingPlatformAuthenticatorAvailable: async () => true,
      }),
    ).resolves.toBe("ok");
  });

  it("reports partial when only a security key or phone could finish", async () => {
    await expect(
      detectWebAuthn({
        isUserVerifyingPlatformAuthenticatorAvailable: async () => false,
      }),
    ).resolves.toBe("partial");
  });
});
