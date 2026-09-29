import type { VaultHeader } from "@opensesame/vault-core";
import { describe, expect, it } from "vitest";
import {
  chooseUnlockMethod,
  protectorUnlocksVault,
} from "./unlock-preference.js";

function header(preferred: string | undefined): VaultHeader {
  const built: VaultHeader = {
    v: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    protection: {
      schemaVersion: 1,
      vaultId: "v",
      rootKeyId: "r",
      rootEpoch: 0,
      revision: 1,
      purpose: "human-vault-root",
      records: [
        {
          kind: "password",
          protectorId: "password_a",
          legacy: true,
          kdf: { alg: "PBKDF2-SHA256", saltB64: "c2FsdA==", iterations: 1 },
          wrap: { ivB64: "aXY=", ctB64: "Y3Q=" },
          proofStatus: "verified",
        },
        {
          kind: "pin",
          protectorId: "pin_a",
          legacy: true,
          saltB64: "c2FsdA==",
          iterations: 1,
          wrap: { ivB64: "aXY=", ctB64: "Y3Q=" },
          proofStatus: "verified",
        },
        {
          kind: "recovery-key",
          protectorId: "recovery_a",
          wrap: { ivB64: "aXY=", ctB64: "Y3Q=" },
          fingerprintB64: "ZnA=",
          proofStatus: "verified",
        },
      ],
    },
  };
  if (preferred && built.protection) {
    built.protection.preferredProtectorId = preferred;
  }
  return built;
}

describe("which protectors open the vault", () => {
  it("names the header's own wraps, and a passkey only when it is one", () => {
    expect(protectorUnlocksVault({ kind: "password" })).toBe(true);
    expect(protectorUnlocksVault({ kind: "pin" })).toBe(true);
    expect(protectorUnlocksVault({ kind: "webauthn-prf", legacy: true })).toBe(
      true,
    );
    expect(protectorUnlocksVault({ kind: "webauthn-prf", legacy: false })).toBe(
      false,
    );
    for (const kind of [
      "recovery-key",
      "age-recipient",
      "age-webauthn",
      "aws-kms",
      "gcp-kms",
      "azure-key-vault-keys",
      "yubikey-piv-age",
      "device-local",
    ] as const) {
      expect(protectorUnlocksVault({ kind })).toBe(false);
    }
  });
});

describe("the preferred unlock method", () => {
  it("defaults to passkey, then PIN, then password", () => {
    expect(chooseUnlockMethod(header(undefined), ["password", "pin"])).toBe(
      "pin",
    );
    expect(chooseUnlockMethod(header(undefined), ["password"])).toBe(
      "password",
    );
    expect(chooseUnlockMethod(header(undefined), [])).toBeNull();
  });

  it("follows the preferred wrap when this header still offers it", () => {
    expect(chooseUnlockMethod(header("password_a"), ["password", "pin"])).toBe(
      "password",
    );
    expect(chooseUnlockMethod(header("pin_a"), ["password", "pin"])).toBe(
      "pin",
    );
    // Preferred, but the wrap went away: the default answers.
    expect(chooseUnlockMethod(header("pin_a"), ["password"])).toBe("password");
  });

  it("ignores a preference that names a protector that opens nothing here", () => {
    expect(chooseUnlockMethod(header("recovery_a"), ["password", "pin"])).toBe(
      "pin",
    );
  });
});
