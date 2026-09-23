import { type BoundaryValue, overlapCast } from "@opensesame/os-domain";
import {
  VaultCorruptError,
  type VaultHeader,
  WrongPasswordError,
  createVault,
  importVaultKey,
  randomBytes,
} from "@opensesame/vault-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_PIN_LENGTH,
  MIN_PIN_LENGTH,
  type PinUnlockRecord,
  WebauthnHostError,
  assertKeepsPrimaryUnlock,
  assertPinPolicy,
  assertWebauthnHost,
  checkWebauthnHost,
  createPasskeyUnlockCeremony,
  describeWebauthnError,
  exportRawVaultKey,
  formatWebauthnHostError,
  getPasskeyUnlockCeremony,
  isIpHostname,
  localhostEquivalentHref,
  openTotpSecret,
  pinPolicyProblems,
  preferredUnlockMethod,
  prfExtensionSupported,
  primaryUnlockCount,
  readPrfFirst,
  sealTotpSecret,
  unwrapVaultKeyWithPin,
  unwrapVaultKeyWithPrf,
  wrapVaultKeyWithPin,
  wrapVaultKeyWithPrf,
} from "./unlock-methods.js";

const PASSWORD = "correct horse battery staple";
const PIN = "48291037";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("passkey ceremonies", () => {
  class TestPublicKeyCredential implements Credential {
    readonly id = "test-credential";
    readonly type = "public-key";
    readonly rawId: ArrayBuffer;

    constructor(
      private readonly extensionResults: BoundaryValue,
      rawId: ArrayBuffer = randomBytes(16).buffer,
    ) {
      this.rawId = rawId;
    }

    getClientExtensionResults(): BoundaryValue {
      return this.extensionResults;
    }
  }

  /** Matches credentialIdB64 "YQ==" used by the enrolled-record fixtures. */
  const enrolledRawId: ArrayBuffer = overlapCast(Uint8Array.of(0x61).buffer);

  type CredentialOverrides = {
    create?: (options: CredentialCreationOptions) => Promise<Credential | null>;
    get?: (options: CredentialRequestOptions) => Promise<Credential | null>;
  };

  function stubCredentials(overrides: CredentialOverrides): void {
    vi.stubGlobal("PublicKeyCredential", TestPublicKeyCredential);
    vi.stubGlobal("navigator", { credentials: overrides });
  }

  it("throws plainly when the browser has no WebAuthn at all", async () => {
    await expect(createPasskeyUnlockCeremony()).rejects.toThrow(
      /cannot create a passkey/,
    );
    await expect(
      getPasskeyUnlockCeremony({
        credentialIdB64: "YQ==",
        userIdB64: "YQ==",
        prfSaltB64: "YQ==",
        wrap: { ivB64: "YQ==", ctB64: "YQ==" },
      }),
    ).rejects.toThrow(/cannot use a passkey/);
  });

  it("creates a credential and returns its PRF output", async () => {
    const prfOutput: ArrayBuffer = overlapCast(randomBytes(32).buffer);
    stubCredentials({
      create: async (options) => {
        const { publicKey } = options;
        if (!publicKey) throw new Error("missing public-key options");
        expect(publicKey.rp.id).toBe("localhost");
        return new TestPublicKeyCredential({
          prf: { results: { first: prfOutput } },
        });
      },
    });
    const result = await createPasskeyUnlockCeremony();
    expect(result.prfOutput).toBe(prfOutput);
    expect(result.prfSalt).toHaveLength(32);
    expect(result.userId).toHaveLength(16);
  });

  it("forwards a deliberate create abort without wrapping it", async () => {
    stubCredentials({
      create: async (options) => {
        expect(options.signal).toBeInstanceOf(AbortSignal);
        throw new DOMException("The operation was aborted.", "AbortError");
      },
    });
    const controller = new AbortController();
    const failure = await createPasskeyUnlockCeremony(
      undefined,
      controller.signal,
    ).catch((error: BoundaryValue) => error);
    expect(failure).toBeInstanceOf(DOMException);
    if (!(failure instanceof DOMException)) throw failure;
    expect(failure.name).toBe("AbortError");
  });

  it("maps a rejected creation into actionable copy", async () => {
    stubCredentials({
      create: async () => {
        throw new DOMException("cancelled", "NotAllowedError");
      },
    });
    await expect(createPasskeyUnlockCeremony()).rejects.toThrow(/cancelled/);
  });

  it("treats a null credential as a cancellation", async () => {
    stubCredentials({ create: async () => null });
    await expect(createPasskeyUnlockCeremony()).rejects.toThrow(/cancelled/);
  });

  it("refuses an authenticator without PRF support", async () => {
    stubCredentials({
      create: async () => new TestPublicKeyCredential({}),
    });
    await expect(createPasskeyUnlockCeremony()).rejects.toThrow(/PRF result/);
  });

  it("gets a PRF output for an enrolled record", async () => {
    const prfOutput: ArrayBuffer = overlapCast(randomBytes(32).buffer);
    let seenRpId: string | undefined;
    stubCredentials({
      get: async (options) => {
        seenRpId = options.publicKey?.rpId;
        return new TestPublicKeyCredential(
          { prf: { results: { first: prfOutput } } },
          enrolledRawId,
        );
      },
    });
    const record = {
      credentialIdB64: "YQ==",
      userIdB64: "YQ==",
      prfSaltB64: "YQ==",
      wrap: { ivB64: "YQ==", ctB64: "YQ==" },
    };
    await expect(getPasskeyUnlockCeremony(record)).resolves.toBe(prfOutput);
    expect(seenRpId).toBe("localhost");
  });

  it("forwards an abort signal and rethrows AbortError unwrapped", async () => {
    let seenSignal: AbortSignal | undefined;
    stubCredentials({
      get: async (options) => {
        seenSignal = options.signal;
        throw new DOMException("The operation was aborted.", "AbortError");
      },
    });
    const record = {
      credentialIdB64: "YQ==",
      userIdB64: "YQ==",
      prfSaltB64: "YQ==",
      wrap: { ivB64: "YQ==", ctB64: "YQ==" },
    };
    const controller = new AbortController();
    const failure = await getPasskeyUnlockCeremony(
      record,
      "localhost",
      controller.signal,
    ).catch((error: BoundaryValue) => error);
    expect(seenSignal).toBe(controller.signal);
    // Deliberate cancels must stay distinguishable from ceremony failures.
    expect(failure).toBeInstanceOf(DOMException);
    if (!(failure instanceof DOMException)) throw failure;
    expect(failure.name).toBe("AbortError");
  });

  it("maps unlock ceremony failures the same way", async () => {
    const record = {
      credentialIdB64: "YQ==",
      userIdB64: "YQ==",
      prfSaltB64: "YQ==",
      wrap: { ivB64: "YQ==", ctB64: "YQ==" },
    };

    stubCredentials({
      get: async () => {
        throw new DOMException("cancelled", "NotAllowedError");
      },
    });
    await expect(getPasskeyUnlockCeremony(record)).rejects.toThrow(/cancelled/);

    stubCredentials({ get: async () => null });
    await expect(getPasskeyUnlockCeremony(record)).rejects.toThrow(/cancelled/);

    stubCredentials({
      get: async () => new TestPublicKeyCredential({}, enrolledRawId),
    });
    await expect(getPasskeyUnlockCeremony(record)).rejects.toThrow(
      /PRF result/,
    );
  });
});
