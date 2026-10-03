/**
 * Unlock from the protectors that open by a ceremony rather than a typed key
 * (ADR 0152): an age passkey, and a passkey capsule enrolled in the manifest.
 * The WebAuthn prompt needs a real authenticator, so it is a stand-in here;
 * the capsules, the wrap, the lockout and the header run for real.
 */
import {
  type AgeWebauthnProtectorRecord,
  type ProtectionContext,
  type ProtectionRecord,
  WrongPasswordError,
  randomBytes,
} from "@opensesame/vault-core";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { kvGet, kvSet } from "../kv.js";
import {
  type AgeWebauthnCrypto,
  enrollAgeWebauthn,
} from "./protection/adapters/age-webauthn.js";
import { protectorFromPrfMaterial } from "./protection/adapters/webauthn-prf-ops.js";
import { ProtectionError } from "./protection/errors.js";
import { sealAuthenticatedManifest } from "./protection/manifest-auth.js";
import {
  HEADER_KEY,
  PASSWORD,
  clearVaultSurface,
} from "./protection/protector-enrollment.test-support.js";
import { VaultStore } from "./store.js";
import { unlockMethodsSeams } from "./unlock-methods.js";

const originalSeams = { ...unlockMethodsSeams };
afterAll(() => {
  Object.assign(unlockMethodsSeams, originalSeams);
});
beforeEach(clearVaultSurface);

const utf8 = (text: string) => new TextEncoder().encode(text);

/** An authenticator: only the identity it minted decrypts what it encrypted. */
function fakeAgePasskey(
  behaviour: "answers" | "dismissed" | "wrong-key" = "answers",
): AgeWebauthnCrypto {
  return {
    createCredential: async () => "AGE-PLUGIN-WEBAUTHN-1FIXTURE",
    encrypt: async (plaintext, identity) =>
      new Uint8Array([...utf8(`${identity}|`), ...plaintext]),
    decrypt: async (ciphertext, identity) => {
      if (behaviour === "dismissed") {
        throw new DOMException("not allowed", "NotAllowedError");
      }
      const prefix = utf8(`${identity}|`);
      const held = new TextDecoder().decode(ciphertext.slice(0, prefix.length));
      if (behaviour === "wrong-key" || held !== `${identity}|`) {
        throw new Error("no identity matched");
      }
      return ciphertext.slice(prefix.length);
    },
  };
}

type Fixture = {
  root: Uint8Array;
  locked: () => VaultStore;
  addToManifest: (
    make: (
      context: ProtectionContext,
      root: Uint8Array,
    ) => Promise<ProtectionRecord>,
    protectorId: string,
  ) => Promise<void>;
};

/** A vault with a recovery key (to read the root back from) and its header. */
async function fixture(): Promise<Fixture> {
  const store = new VaultStore();
  await store.create(PASSWORD);
  const candidate = await store.protection.enrollCandidate("recovery-key");
  await store.protection.commitEnrollment(candidate.operationId);
  const root = await store.protection.openRecoveryKey(
    candidate.recoverySecretB64 ?? "",
  );
  store.lock();
  return {
    root,
    locked: () => new VaultStore(),
    async addToManifest(make, protectorId) {
      const header = JSON.parse(kvGet(HEADER_KEY) ?? "{}");
      const m = header.protection;
      const context: ProtectionContext = {
        vaultId: m.vaultId,
        rootKeyId: m.rootKeyId,
        rootEpoch: m.rootEpoch,
        protectorId,
        purpose: m.purpose,
      };
      m.records.push(await make(context, root));
      // Enrolled as the service would: the manifest is re-authenticated under
      // the root, which is what the unlock path checks the opened root against.
      const { authB64: _stale, ...body } = m;
      header.protection = await sealAuthenticatedManifest(root, body);
      kvSet(HEADER_KEY, JSON.stringify(header));
    },
  };
}

async function withAgePasskey(): Promise<Fixture> {
  const f = await fixture();
  await f.addToManifest(async (context, root) => {
    const enrolled = await enrollAgeWebauthn({
      context,
      rootKey: root,
      crypto: fakeAgePasskey(),
    });
    const record: AgeWebauthnProtectorRecord = enrolled.record;
    return record;
  }, "age-webauthn_fixture");
  return f;
}

describe("unlock with an enrolled age passkey", () => {
  it("opens the vault when the authenticator answers", async () => {
    const f = await withAgePasskey();
    const locked = f.locked();
    await locked.unlockWithProtector({
      method: "agePasskey",
      ageWebauthnCrypto: fakeAgePasskey(),
    });
    expect(locked.getSnapshot().status).toBe("unlocked");
  });

  it("counts a key that does not open the capsule like a wrong password", async () => {
    const f = await withAgePasskey();
    const locked = f.locked();
    await expect(
      locked.unlockWithProtector({
        method: "agePasskey",
        ageWebauthnCrypto: fakeAgePasskey("wrong-key"),
      }),
    ).rejects.toBeInstanceOf(WrongPasswordError);
    expect(locked.getSnapshot().failedAttempts).toBe(1);
    expect(locked.getSnapshot().status).toBe("locked");
  });

  it("does not count a prompt the person dismissed", async () => {
    const f = await withAgePasskey();
    const locked = f.locked();
    await expect(
      locked.unlockWithProtector({
        method: "agePasskey",
        ageWebauthnCrypto: fakeAgePasskey("dismissed"),
      }),
    ).rejects.toBeInstanceOf(ProtectionError);
    expect(locked.getSnapshot().failedAttempts).toBe(0);
  });

  it("opens in two phases, so a duress gate can sit between tap and code", async () => {
    const f = await withAgePasskey();
    const locked = f.locked();
    const root = await locked.probeProtector({
      method: "agePasskey",
      ageWebauthnCrypto: fakeAgePasskey(),
    });
    expect(root.byteLength).toBe(32);
    // Nothing is open until the held root is spent.
    expect(locked.getSnapshot().status).toBe("locked");
    await locked.unlockWithHeldProtectorRoot(root, { method: "agePasskey" });
    expect(locked.getSnapshot().status).toBe("unlocked");
  });

  describe("when the person leaves the tab while the prompt is up", () => {
    /** The age library takes no signal: the prompt can only answer, late. */
    function lateAnswer(
      outcome: "fails" | "succeeds" | "never",
      controller: AbortController,
    ): AgeWebauthnCrypto {
      const real = fakeAgePasskey();
      return {
        ...real,
        decrypt: (ciphertext, identity) =>
          outcome === "never"
            ? new Promise<Uint8Array>(() => undefined)
            : new Promise<Uint8Array>((resolve, reject) => {
                controller.signal.addEventListener("abort", () => {
                  setTimeout(() => {
                    if (outcome === "fails") reject(new Error("late failure"));
                    else resolve(real.decrypt(ciphertext, identity));
                  }, 0);
                });
              }),
      };
    }

    it("does not count a failure that lands after the abort", async () => {
      const f = await withAgePasskey();
      const locked = f.locked();
      const controller = new AbortController();
      const pending = locked.unlockWithProtector({
        method: "agePasskey",
        signal: controller.signal,
        ageWebauthnCrypto: lateAnswer("fails", controller),
      });
      controller.abort();
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      expect(locked.getSnapshot().failedAttempts).toBe(0);
      expect(locked.getSnapshot().status).toBe("locked");
    });

    it("spends no root the prompt answers after the abort", async () => {
      const f = await withAgePasskey();
      const locked = f.locked();
      const controller = new AbortController();
      const pending = locked.probeProtector({
        method: "agePasskey",
        signal: controller.signal,
        ageWebauthnCrypto: lateAnswer("succeeds", controller),
      });
      controller.abort();
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      expect(locked.getSnapshot().failedAttempts).toBe(0);
      expect(locked.getSnapshot().status).toBe("locked");
    });

    it("stops waiting for a prompt that never answers", async () => {
      const f = await withAgePasskey();
      const locked = f.locked();
      const controller = new AbortController();
      const pending = locked.unlockWithProtector({
        method: "agePasskey",
        signal: controller.signal,
        ageWebauthnCrypto: lateAnswer("never", controller),
      });
      controller.abort();
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      expect(locked.getSnapshot().failedAttempts).toBe(0);
    });
  });

  it("counts a held root of the wrong size and opens nothing", async () => {
    const f = await withAgePasskey();
    const locked = f.locked();
    await expect(
      locked.unlockWithHeldProtectorRoot(new ArrayBuffer(8), {
        method: "agePasskey",
      }),
    ).rejects.toBeInstanceOf(WrongPasswordError);
    expect(locked.getSnapshot().failedAttempts).toBe(1);
    expect(locked.getSnapshot().status).toBe("locked");
  });
});

describe("unlock with a passkey capsule enrolled in the manifest", () => {
  async function withCapsule(prfOutput: ArrayBuffer): Promise<Fixture> {
    const f = await fixture();
    await f.addToManifest(
      (_context, root) =>
        protectorFromPrfMaterial({
          rootKey: root,
          prfOutput,
          prfSalt: randomBytes(32),
          credentialId: randomBytes(16),
          userId: randomBytes(16),
          protectorId: "webauthn-prf_capsule",
        }),
      "webauthn-prf_capsule",
    );
    return f;
  }

  it("opens through the passkey road, though the header holds no passkey", async () => {
    const prf = randomBytes(32).slice().buffer;
    const f = await withCapsule(prf);
    Object.assign(unlockMethodsSeams, {
      getPasskeyUnlockCeremony: async () => prf,
    });
    const locked = f.locked();
    expect(locked.getSnapshot().header?.unlocks?.passkey).toBeUndefined();
    await locked.unlockWithPasskey();
    expect(locked.getSnapshot().status).toBe("unlocked");
  });

  it("counts an authenticator whose output opens no capsule", async () => {
    const f = await withCapsule(randomBytes(32).slice().buffer);
    Object.assign(unlockMethodsSeams, {
      getPasskeyUnlockCeremony: async () => randomBytes(32).slice().buffer,
    });
    const locked = f.locked();
    await expect(locked.unlockWithPasskey()).rejects.toBeInstanceOf(
      WrongPasswordError,
    );
    expect(locked.getSnapshot().failedAttempts).toBe(1);
    expect(locked.getSnapshot().status).toBe("locked");
  });
});
