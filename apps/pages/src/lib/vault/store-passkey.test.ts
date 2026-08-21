import { type BoundaryValue, overlapCast } from "@opensesame/os-domain";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { kvDelete, kvGet } from "../kv.js";
import { WrongPasswordError, randomBytes } from "./crypto.js";
import { ATTEMPTS_KEY, BODY_KEY, HEADER_KEY, VaultStore } from "./store.js";
import type { PasskeyCeremony } from "./unlock-methods.js";
import { unlockMethodsSeams } from "./unlock-methods.js";

const PASSWORD = "correct horse battery staple";

/**
 * The WebAuthn ceremony needs a real authenticator; everything around it —
 * wrapping, unwrapping, header persistence — runs for real. These stand-ins
 * return the PRF output a platform authenticator would have produced.
 */
const ceremony = vi.hoisted(() => ({
  prfOutput: null,
  failCreate: null,
  failGet: null,
  noPrf: false,
}));

const originalUnlockMethodsSeams = { ...unlockMethodsSeams };
Object.assign(unlockMethodsSeams, {
  createPasskeyUnlockCeremony: async (
    _rpId?: string,
    signal?: AbortSignal,
  ): Promise<PasskeyCeremony> => {
    if (signal?.aborted) {
      throw new DOMException("The operation was aborted.", "AbortError");
    }
    if (ceremony.failCreate) throw ceremony.failCreate;
    ceremony.prfOutput = overlapCast(randomBytes(32).buffer);
    return {
      credential: overlapCast({ rawId: randomBytes(16).buffer }),
      prfOutput: ceremony.prfOutput,
      prfSalt: randomBytes(16),
      userId: randomBytes(16),
    };
  },
  getPasskeyUnlockCeremony: async (): Promise<ArrayBuffer> => {
    if (ceremony.failGet) throw ceremony.failGet;
    if (ceremony.noPrf || !ceremony.prfOutput) {
      throw new Error(
        "This authenticator did not return a WebAuthn PRF result for unlock.",
      );
    }
    return ceremony.prfOutput;
  },
});

beforeEach(() => {
  kvDelete(ATTEMPTS_KEY);
  kvDelete(HEADER_KEY);
  kvDelete(BODY_KEY);
  ceremony.prfOutput = null;
  ceremony.failCreate = null;
  ceremony.failGet = null;
  ceremony.noPrf = false;
});

describe("VaultStore passkey unlock", () => {
  it("seals a new vault with a passkey and no master password", async () => {
    const store = new VaultStore();
    await store.createWithPasskey();
    const header = store.getSnapshot().header;
    expect(header?.unlocks?.passkey).toBeDefined();
    expect(header?.wrap).toBeUndefined();
    expect(header?.kdf).toBeUndefined();
    expect(store.getSnapshot().status).toBe("unlocked");
    store.lock();

    const reopened = new VaultStore();
    await reopened.unlockWithPasskey();
    expect(reopened.getSnapshot().status).toBe("unlocked");
  });

  it("does not persist a vault if passkey creation fails", async () => {
    ceremony.failCreate = new Error("no authenticator");
    const store = new VaultStore();
    await expect(store.createWithPasskey()).rejects.toThrow(/no authenticator/);
    expect(store.getSnapshot().status).toBe("empty");
    expect(kvGet(HEADER_KEY)).toBeNull();
  });

  it("does not persist a vault if the first-run ceremony is aborted", async () => {
    const store = new VaultStore();
    const controller = new AbortController();
    controller.abort();
    const failure = await store
      .createWithPasskey(controller.signal)
      .catch((error: BoundaryValue) => error);
    expect(failure).toBeInstanceOf(DOMException);
    expect(overlapCast(failure).name).toBe("AbortError");
    expect(store.getSnapshot().status).toBe("empty");
    expect(kvGet(HEADER_KEY)).toBeNull();
  });

  it("enrolls a passkey and unlocks with it after locking", async () => {
    const store = new VaultStore();
    await store.create(PASSWORD);
    await store.enrollPasskey();
    expect(store.getSnapshot().header?.unlocks?.passkey).toBeDefined();
    store.lock();

    const reopened = new VaultStore();
    await reopened.unlockWithPasskey();
    expect(reopened.getSnapshot().status).toBe("unlocked");
    expect(reopened.isUnlocked()).toBe(true);
  });

  it("removes an enrolled passkey and refuses it afterwards", async () => {
    const store = new VaultStore();
    await store.create(PASSWORD);
    await store.enrollPasskey();
    await store.removePasskey();
    expect(store.getSnapshot().header?.unlocks?.passkey).toBeUndefined();
    store.lock();

    const reopened = new VaultStore();
    await expect(reopened.unlockWithPasskey()).rejects.toThrow(
      /no passkey unlock/,
    );
  });

  it("keeps the last primary method when removing a passkey", async () => {
    const store = new VaultStore();
    await store.create(PASSWORD);
    await store.enrollPasskey();
    await store.removePassword();
    await expect(store.removePasskey()).rejects.toThrow(/at least one primary/);
  });

  it("surfaces a cancelled ceremony without counting a failed attempt", async () => {
    const store = new VaultStore();
    await store.create(PASSWORD);
    await store.enrollPasskey();
    store.lock();

    ceremony.failGet = new Error(
      "Passkey was cancelled or timed out. Try again, or use a PIN / password unlock instead.",
    );
    const reopened = new VaultStore();
    await expect(reopened.unlockWithPasskey()).rejects.toThrow(/cancelled/);
    // A cancelled ceremony is not a wrong credential.
    expect(reopened.getSnapshot().failedAttempts).toBe(0);
  });

  it("counts a passkey whose PRF does not unwrap the vault", async () => {
    const store = new VaultStore();
    await store.create(PASSWORD);
    await store.enrollPasskey();
    store.lock();

    // A different passkey: the ceremony succeeds but the wrap does not open.
    ceremony.prfOutput = overlapCast(randomBytes(32).buffer);
    const reopened = new VaultStore();
    await expect(reopened.unlockWithPasskey()).rejects.toBeInstanceOf(
      WrongPasswordError,
    );
    expect(reopened.getSnapshot().failedAttempts).toBe(1);
  });

  it("normalizes a non-Error ceremony failure", async () => {
    const store = new VaultStore();
    await store.create(PASSWORD);
    await store.enrollPasskey();
    store.lock();

    ceremony.failGet = overlapCast("string failure");
    const reopened = new VaultStore();
    await expect(reopened.unlockWithPasskey()).rejects.toThrow(
      /Passkey unlock failed/,
    );
  });

  it("rethrows a deliberate abort unwrapped and counts no failed attempt", async () => {
    const store = new VaultStore();
    await store.create(PASSWORD);
    await store.enrollPasskey();
    store.lock();

    ceremony.failGet = new DOMException(
      "The operation was aborted.",
      "AbortError",
    );
    const reopened = new VaultStore();
    const failure = await reopened
      .unlockWithPasskey(new AbortController().signal)
      .catch((error: BoundaryValue) => error);
    expect(failure).toBeInstanceOf(DOMException);
    expect(overlapCast(failure).name).toBe("AbortError");
    // Switching methods mid-ceremony is not a wrong credential.
    expect(reopened.getSnapshot().failedAttempts).toBe(0);
  });
});
