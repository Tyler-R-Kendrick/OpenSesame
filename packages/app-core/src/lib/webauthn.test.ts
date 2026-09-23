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

describe("detectWebAuthn failure modes", () => {
  it("reports partial when the availability probe throws", async () => {
    await expect(
      detectWebAuthn({
        isUserVerifyingPlatformAuthenticatorAvailable: async () => {
          throw new Error("not implemented");
        },
      }),
    ).resolves.toBe("partial");
  });
});

describe("detectWebAuthn defaults", () => {
  it("probes the ambient PublicKeyCredential when none is passed", async () => {
    // Node has no WebAuthn API, so the default argument resolves to missing.
    await expect(detectWebAuthn()).resolves.toBe("missing");
  });
});
