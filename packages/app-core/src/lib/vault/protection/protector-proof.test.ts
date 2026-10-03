import type { ProtectionContext } from "@opensesame/vault-core";
import { describe, expect, it } from "vitest";
import {
  type AgeWebauthnCrypto,
  enrollAgeWebauthn,
} from "./adapters/age-webauthn.js";
import { proveRecord } from "./protector-proof.js";

const CONTEXT: ProtectionContext = {
  vaultId: "vault-1",
  rootKeyId: "root-1",
  rootEpoch: 1,
  protectorId: "age-webauthn-1",
  purpose: "human-vault-root",
};

function fakeCrypto(): AgeWebauthnCrypto {
  const byCt = new Map<string, Uint8Array>();
  return {
    async createCredential() {
      return "AGE-PLUGIN-FIDO2PRF-1-TEST";
    },
    async encrypt(plaintext) {
      const ct = crypto.getRandomValues(new Uint8Array(48));
      byCt.set(btoa(String.fromCharCode(...ct)), new Uint8Array(plaintext));
      return ct;
    },
    async decrypt(ciphertext) {
      const plain = byCt.get(btoa(String.fromCharCode(...ciphertext)));
      if (!plain) throw new Error("missing");
      return new Uint8Array(plain);
    },
  };
}

describe("proving an age passkey", () => {
  it("runs the passkey ceremony and compares the root, instead of re-marking verified", async () => {
    const rootKey = crypto.getRandomValues(new Uint8Array(32));
    const cryptoApi = fakeCrypto();
    const { record } = await enrollAgeWebauthn({
      context: CONTEXT,
      rootKey,
      crypto: cryptoApi,
    });
    const stale = { ...record, proofStatus: "stale" as const };
    const proved = await proveRecord({
      record: stale,
      context: CONTEXT,
      rootKey,
      material: { ageWebauthnCrypto: cryptoApi },
    });
    expect(proved.proofStatus).toBe("verified");
    expect(proved.lastEvidence?.kind).toBe("software-roundtrip");

    await expect(
      proveRecord({
        record: stale,
        context: CONTEXT,
        rootKey: crypto.getRandomValues(new Uint8Array(32)),
        material: { ageWebauthnCrypto: cryptoApi },
      }),
    ).rejects.toMatchObject({ code: "enrollment_proof_failed" });
  });
});
