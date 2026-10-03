import { beforeAll, describe, expect, it } from "vitest";
import {
  type BackupStore,
  type RecoveryKeyPair,
  backUp,
  backupId,
  createRecoveryKey,
  importRecipient,
  openBackup,
  sealBackup,
} from "./backup";

let pair: RecoveryKeyPair;
beforeAll(async () => {
  pair = await createRecoveryKey();
});

const BINDING = {
  handle: "candidate:0190aaaa-bbbb",
  origin: "https://rp.example",
};

describe("the recovery key", () => {
  it("is a public RSA-OAEP key only, of at least 3072 bits", async () => {
    expect(pair.recipient.jwk.d).toBeUndefined();
    expect(pair.privateJwk.d).toBeDefined();
    expect(pair.recipient.kid).toMatch(/^[0-9a-f]{64}$/);
    expect(await importRecipient(pair.recipient.jwk)).toEqual(pair.recipient);
  });

  it("refuses a private key, a symmetric key, a short key and a wrong algorithm", async () => {
    expect(await importRecipient(pair.privateJwk)).toBeNull();
    expect(await importRecipient({ kty: "oct", k: "AAAA" })).toBeNull();
    expect(
      await importRecipient({ kty: "RSA", n: "AQAB", e: "AQAB" }),
    ).toBeNull();
    expect(
      await importRecipient({ ...pair.recipient.jwk, alg: "RSA1_5" }),
    ).toBeNull();
    expect(await importRecipient({ kty: "RSA", e: "AQAB" })).toBeNull();
  });
});

describe("the envelope", () => {
  it("opens to the secret for the holder of the private key, and to nothing else", async () => {
    const bytes = await sealBackup(pair.recipient, BINDING, "s3cret-value");
    expect(new TextDecoder().decode(bytes)).not.toContain("s3cret-value");
    expect(await openBackup(pair.privateJwk, bytes)).toBe("s3cret-value");
    const other = await createRecoveryKey();
    await expect(openBackup(other.privateJwk, bytes)).rejects.toThrow();
  });

  it("is bound to its handle and origin, so it opens as no other candidate's", async () => {
    const bytes = await sealBackup(pair.recipient, BINDING, "v");
    const envelope = JSON.parse(new TextDecoder().decode(bytes));
    for (const swapped of [
      { ...envelope, handle: "candidate:0190cccc-dddd" },
      { ...envelope, origin: "https://evil.example" },
    ]) {
      await expect(
        openBackup(
          pair.privateJwk,
          new TextEncoder().encode(JSON.stringify(swapped)),
        ),
      ).rejects.toThrow();
    }
  });

  it("is a fresh ciphertext every time", async () => {
    const a = await sealBackup(pair.recipient, BINDING, "same");
    const b = await sealBackup(pair.recipient, BINDING, "same");
    expect(new TextDecoder().decode(a)).not.toBe(new TextDecoder().decode(b));
  });

  it("names a sync id the Host will store", () => {
    expect(backupId("candidate:0190aaaa-bbbb")).toBe(
      "runner-candidate.0190aaaa-bbbb",
    );
    expect(backupId(`candidate:${"x".repeat(300)}`).length).toBeLessThanOrEqual(
      128,
    );
    expect(backupId("candidate:a/b c")).toBe("runner-candidate.a_b_c");
  });
});

describe("backUp acknowledges only a backup that was proven", () => {
  const store = (overrides: Partial<BackupStore>): BackupStore => ({
    push: async () => true,
    confirm: async () => true,
    ...overrides,
  });

  it("true when pushed and read back", async () => {
    expect(await backUp(store({}), pair.recipient, BINDING, "v")).toBe(true);
  });

  it("false when the Host refuses, when the read-back fails, and when anything throws", async () => {
    expect(
      await backUp(
        store({ push: async () => false }),
        pair.recipient,
        BINDING,
        "v",
      ),
    ).toBe(false);
    expect(
      await backUp(
        store({ confirm: async () => false }),
        pair.recipient,
        BINDING,
        "v",
      ),
    ).toBe(false);
    expect(
      await backUp(
        store({
          push: async () => {
            throw new Error("down");
          },
        }),
        pair.recipient,
        BINDING,
        "v",
      ),
    ).toBe(false);
  });

  it("does not read back what it did not push", async () => {
    let confirmed = false;
    await backUp(
      store({
        push: async () => false,
        confirm: async () => {
          confirmed = true;
          return true;
        },
      }),
      pair.recipient,
      BINDING,
      "v",
    );
    expect(confirmed).toBe(false);
  });
});
