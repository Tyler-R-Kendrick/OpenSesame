import type { VaultHeader } from "@opensesame/vault-core";
import { describe, expect, it } from "vitest";
import {
  protectionMechanismLabel,
  selectProtectionView,
} from "./protection-view.js";

describe("protection-view", () => {
  it("never labels WebCrypto as a protector", () => {
    expect(protectionMechanismLabel("password")).toBe("Password");
    expect(protectionMechanismLabel("webauthn-prf")).toBe(
      "Passkey / security key",
    );
  });

  it("derives enrolled methods from header wrap/unlocks", () => {
    const view = selectProtectionView({
      header: {
        v: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        kdf: {
          alg: "PBKDF2-SHA256",
          saltB64: "c2FsdA==",
          iterations: 600_000,
        },
        wrap: { ivB64: "aXY=", ctB64: "Y3Q=" },
        unlocks: {
          pin: {
            kdf: {
              alg: "PBKDF2-SHA256",
              saltB64: "cGlu",
              iterations: 100_000,
            },
            wrap: { ivB64: "aXY=", ctB64: "cGluY3Q=" },
          },
        },
      },
    });
    expect(view.methods.map((row) => row.mechanismLabel)).toEqual([
      "Password",
      "PIN",
    ]);
    expect(view.lifecycleReady).toBe(true);
  });

  it("KP-04: only an enrolled protector is a row — a saved cloud preference is not", () => {
    const view = selectProtectionView({
      header: {
        v: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        kdf: {
          alg: "PBKDF2-SHA256",
          saltB64: "c2FsdA==",
          iterations: 600_000,
        },
        wrap: { ivB64: "aXY=", ctB64: "Y3Q=" },
      },
    });
    expect(view.methods.map((row) => row.kind)).toEqual(["password"]);
    expect("setupIntent" in view).toBe(false);
  });

  it("reads the header's sealed manifest, so ids are stable and every record is listed", () => {
    const header: VaultHeader = {
      v: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      kdf: {
        alg: "PBKDF2-SHA256",
        saltB64: "c2FsdA==",
        iterations: 600_000,
      },
      wrap: { ivB64: "aXY=", ctB64: "Y3Q=" },
      protection: {
        schemaVersion: 1,
        vaultId: "vault_x",
        rootKeyId: "root_x",
        rootEpoch: 0,
        revision: 2,
        purpose: "human-vault-root",
        preferredProtectorId: "password_kept",
        records: [
          {
            kind: "password",
            protectorId: "password_kept",
            legacy: true,
            kdf: {
              alg: "PBKDF2-SHA256",
              saltB64: "c2FsdA==",
              iterations: 600_000,
            },
            wrap: { ivB64: "aXY=", ctB64: "Y3Q=" },
            proofStatus: "verified",
          },
          {
            kind: "recovery-key",
            protectorId: "recovery-key_kept",
            wrap: { ivB64: "aXY=", ctB64: "Y3Q=" },
            fingerprintB64: "ZnA=",
            proofStatus: "verified",
          },
        ],
        authB64: "YXV0aA==",
      },
    };
    const first = selectProtectionView({ header });
    const second = selectProtectionView({ header });
    expect(first.methods.map((row) => row.protectorId)).toEqual([
      "password_kept",
      "recovery-key_kept",
    ]);
    // Not re-minted per call: this id is what the service is asked to act on.
    expect(second.methods.map((row) => row.protectorId)).toEqual(
      first.methods.map((row) => row.protectorId),
    );
    expect(first.preferredProtectorId).toBe("password_kept");
  });
});
