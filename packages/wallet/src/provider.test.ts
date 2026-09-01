import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GOOGLE_WALLET_ENV, WalletConfigError } from "./config.js";
import { createWalletProvider } from "./index.js";
import { NullWalletProvider, WalletNotConfiguredError } from "./provider.js";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const INPUT = {
  interactionRef: "i_aW50X0FiQ2Q.Op9Xq2KfLmNb",
  interactionUrl:
    "https://interactions.example.test/i/i_aW50X0FiQ2Q.Op9Xq2KfLmNb",
  kind: "device_authorization",
  title: "Approve terminal login",
  expiresAt: new Date("2030-01-01T00:00:00.000Z"),
} as const;

describe("NullWalletProvider", () => {
  it("reports every capability as absent", () => {
    expect(new NullWalletProvider().capabilities()).toEqual({
      provider: "none",
      available: false,
      issue: false,
      update: false,
      revoke: false,
      rotatingBarcode: false,
    });
  });

  it("refuses to issue rather than returning a link to nowhere", async () => {
    // The failure mode this exists to prevent: a null provider that returns a
    // plausible artifact, and a human who finds out it is fake by tapping it.
    await expect(new NullWalletProvider().issuePass()).rejects.toBeInstanceOf(
      WalletNotConfiguredError,
    );
  });

  it("refuses to update or revoke a pass that was never issued", async () => {
    const wallet = new NullWalletProvider();
    await expect(wallet.updatePass()).rejects.toBeInstanceOf(
      WalletNotConfiguredError,
    );
    await expect(wallet.revokePass()).rejects.toBeInstanceOf(
      WalletNotConfiguredError,
    );
  });

  it("names itself in the error, so a caller can say which wallet is off", async () => {
    await expect(new NullWalletProvider().issuePass()).rejects.toMatchObject({
      provider: "none",
    });
  });
});

describe("createWalletProvider", () => {
  it("yields NullWalletProvider semantics on an unconfigured environment", async () => {
    const wallet = createWalletProvider({});
    expect(wallet.capabilities()).toEqual({
      provider: "none",
      available: false,
      issue: false,
      update: false,
      revoke: false,
      rotatingBarcode: false,
    });
    await expect(wallet.issuePass(INPUT)).rejects.toBeInstanceOf(
      WalletNotConfiguredError,
    );
  });

  it("yields the Google provider on a complete environment", () => {
    const wallet = createWalletProvider({
      [GOOGLE_WALLET_ENV.issuerId]: "3388000000022125777",
      [GOOGLE_WALLET_ENV.classId]: "interaction",
      [GOOGLE_WALLET_ENV.serviceAccountEmail]:
        "wallet@opensesame-test.iam.gserviceaccount.com",
      [GOOGLE_WALLET_ENV.serviceAccountKeyPem]: privateKey,
      [GOOGLE_WALLET_ENV.publicBaseUrl]: "https://interactions.example.test",
      [GOOGLE_WALLET_ENV.origins]: "https://interactions.example.test",
    });
    expect(wallet.capabilities().provider).toBe("google");
    expect(wallet.capabilities().rotatingBarcode).toBe(false);
  });

  it("propagates a half-configured environment instead of falling back", () => {
    // Falling back to the null provider here would turn a misconfiguration
    // into a silently wallet-less deployment that nobody notices for weeks.
    expect(() =>
      createWalletProvider({
        [GOOGLE_WALLET_ENV.issuerId]: "3388000000022125777",
      }),
    ).toThrow(WalletConfigError);
  });
});
