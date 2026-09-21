import { describe, expect, it } from "vitest";
import { ProtectionError } from "../errors.js";
import type { ProtectionContext } from "../types.js";
import {
  type AgeWebauthnCrypto,
  enrollAgeWebauthn,
  openAgeWebauthn,
} from "./age-webauthn.js";

const CONTEXT: ProtectionContext = {
  vaultId: "vault-1",
  rootKeyId: "root-1",
  rootEpoch: 1,
  protectorId: "",
  purpose: "human-vault-root",
};

function fakeCrypto(): AgeWebauthnCrypto & { identity: string } {
  const byCt = new Map<string, Uint8Array>();
  const identity = "AGE-PLUGIN-FIDO2PRF-1-TEST";
  return {
    identity,
    async createCredential() {
      return identity;
    },
    async encrypt(plaintext) {
      const ct = crypto.getRandomValues(new Uint8Array(48));
      byCt.set(btoa(String.fromCharCode(...ct)), new Uint8Array(plaintext));
      return ct;
    },
    async decrypt(ciphertext) {
      const key = btoa(String.fromCharCode(...ciphertext));
      const plain = byCt.get(key);
      if (!plain) throw new Error("missing");
      return new Uint8Array(plain);
    },
  };
}

describe("age-webauthn protector", () => {
  it("enrolls with open proof and round-trips the root", async () => {
    const rootKey = crypto.getRandomValues(new Uint8Array(32));
    const cryptoApi = fakeCrypto();
    const { record, identity } = await enrollAgeWebauthn({
      context: CONTEXT,
      rootKey,
      crypto: cryptoApi,
    });
    expect(record.kind).toBe("age-webauthn");
    expect(record.proofStatus).toBe("verified");
    expect(identity).toBe(cryptoApi.identity);
    const opened = await openAgeWebauthn({
      context: { ...CONTEXT, protectorId: record.protectorId },
      record,
      crypto: cryptoApi,
    });
    expect(opened).toEqual(rootKey);
  });

  it("refuses wrong-length roots", async () => {
    await expect(
      enrollAgeWebauthn({
        context: CONTEXT,
        rootKey: new Uint8Array(16),
        crypto: fakeCrypto(),
      }),
    ).rejects.toBeInstanceOf(ProtectionError);
  });
});
