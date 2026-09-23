import { describe, expect, it } from "vitest";
import {
  ProtectionNotWiredError,
  preferenceMechanismLabel,
  protectionLifecycleStubs,
  selectProtectionView,
} from "./protection-view.js";

describe("protection-view", () => {
  it("never labels WebCrypto as a protector", () => {
    expect(preferenceMechanismLabel("webcrypto")).toBe("Password");
    expect(preferenceMechanismLabel("fido2")).toBe("Passkey / security key");
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
      encryptionBinding: { providerId: "webcrypto" },
    });
    expect(view.methods.map((row) => row.mechanismLabel)).toEqual([
      "Password",
      "PIN",
    ]);
    expect(view.setupIntent).toBeNull();
    expect(view.lifecycleReady).toBe(true);
  });

  it("KP-04: cloud preference without enrollment is setup intent", () => {
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
      encryptionBinding: { providerId: "aws-kms", connectionId: "c1" },
    });
    expect(view.setupIntent?.providerId).toBe("aws-kms");
    expect(view.setupIntent?.source).toBe("capabilityConnectors.encryption");
  });

  it("stubs throw typed not_wired", () => {
    expect(() => protectionLifecycleStubs.rotateCompromised()).toThrow(
      ProtectionNotWiredError,
    );
  });
});
