import { type BoundaryValue, overlapCast } from "@opensesame/os-domain";
import { randomBytes } from "@opensesame/vault-core";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { kvDelete } from "../../kv.js";
import {
  BODY_PATH,
  HEADER_PATH,
  INDEX_PATH,
  MIGRATION_MARKER_PATH,
  PERSONAL_TOMB,
  readFile,
  tombFileKey,
  vfsFlush,
  vfsSeams,
  writeFile,
} from "../../vfs.js";
import { ATTEMPTS_KEY, VaultStore } from "../store.js";
import { type PasskeyCeremony, unlockMethodsSeams } from "../unlock-methods.js";
import { ProtectionError } from "./errors.js";

/**
 * A vault with no master password is never given one by a rotation (ADR
 * 0180): it is re-keyed under a new passkey, or a PIN where the browser
 * cannot make one, and a refused ceremony leaves it exactly as it was.
 */
const HEADER_KEY = tombFileKey(PERSONAL_TOMB, HEADER_PATH);
const BODY_KEY = tombFileKey(PERSONAL_TOMB, BODY_PATH);
const OLD_PIN = "48291037";
const NEW_PIN = "73920146";

type CeremonyFixture = {
  prfOutput: ArrayBuffer | null;
  failCreate: BoundaryValue;
};

const ceremony: CeremonyFixture = { prfOutput: null, failCreate: null };

const originalSeams = { ...unlockMethodsSeams };
Object.assign(unlockMethodsSeams, {
  createPasskeyUnlockCeremony: async (): Promise<PasskeyCeremony> => {
    if (ceremony.failCreate) throw ceremony.failCreate;
    const prfOutput: ArrayBuffer = overlapCast(randomBytes(32).buffer);
    ceremony.prfOutput = prfOutput;
    return {
      credential: overlapCast({ rawId: randomBytes(16).buffer }),
      prfOutput,
      prfSalt: randomBytes(16),
      userId: randomBytes(16),
    };
  },
  getPasskeyUnlockCeremony: async (): Promise<ArrayBuffer> => {
    if (!ceremony.prfOutput) throw new Error("no passkey was made");
    return ceremony.prfOutput;
  },
});
afterAll(() => {
  Object.assign(unlockMethodsSeams, originalSeams);
});

beforeEach(async () => {
  await vfsFlush();
  kvDelete(ATTEMPTS_KEY);
  kvDelete(HEADER_KEY);
  kvDelete(BODY_KEY);
  kvDelete(tombFileKey(PERSONAL_TOMB, MIGRATION_MARKER_PATH));
  kvDelete(tombFileKey(PERSONAL_TOMB, INDEX_PATH));
  ceremony.prfOutput = null;
  ceremony.failCreate = null;
});

async function passkeyVault(): Promise<VaultStore> {
  const store = new VaultStore();
  await store.createWithPasskey();
  await store.protection.ensureProtectionProjected();
  return store;
}

describe("rotating the vault key of a vault with no master password", () => {
  it("re-keys it under a new passkey and adds no password", async () => {
    const store = await passkeyVault();
    const before = store.getSnapshot().header;
    const oldCredential = before?.unlocks?.passkey?.credentialIdB64;
    await store.protection.rotateCompromisedRoot({ passkey: true });

    const header = store.getSnapshot().header;
    expect(header?.wrap).toBeUndefined();
    expect(header?.kdf).toBeUndefined();
    expect(header?.unlocks?.passkey?.credentialIdB64).not.toBe(oldCredential);
    expect(header?.protection?.rootEpoch).toBe(
      (before?.protection?.rootEpoch ?? 0) + 1,
    );
    expect(
      store.protection.listProtectors().map((record) => record.kind),
    ).not.toContain("password");
    store.lock();

    const reopened = new VaultStore();
    await reopened.unlockWithPasskey();
    expect(reopened.getSnapshot().status).toBe("unlocked");
  });

  it("changes nothing when the new passkey is refused", async () => {
    const store = await passkeyVault();
    const before = store.getSnapshot().header;
    const reusable = ceremony.prfOutput;
    ceremony.failCreate = new Error("the authenticator was dismissed");
    await expect(
      store.protection.rotateCompromisedRoot({ passkey: true }),
    ).rejects.toThrow(/dismissed/);
    expect(store.getSnapshot().header).toEqual(before);
    store.lock();

    ceremony.failCreate = null;
    ceremony.prfOutput = reusable;
    const reopened = new VaultStore();
    await reopened.unlockWithPasskey();
    expect(reopened.getSnapshot().status).toBe("unlocked");
  });

  it("re-keys a PIN vault under a new PIN, and the old one stops opening it", async () => {
    const store = new VaultStore();
    await store.createWithPin(OLD_PIN);
    await store.protection.ensureProtectionProjected();
    await store.protection.rotateCompromisedRoot({ pin: NEW_PIN });
    expect(store.getSnapshot().header?.wrap).toBeUndefined();
    store.lock();

    const stale = new VaultStore();
    await expect(stale.unlockWithPin(OLD_PIN)).rejects.toThrow();
    const reopened = new VaultStore();
    await reopened.unlockWithPin(NEW_PIN);
    expect(reopened.getSnapshot().status).toBe("unlocked");
  });

  it("refuses a PIN below the policy floor before any key changes", async () => {
    const store = await passkeyVault();
    const before = store.getSnapshot().header;
    store.lock();
    await store.unlockWithPasskey();
    // A passkey vault holds no password, so a PIN is the typed road here.
    await expect(
      store.protection.rotateCompromisedRoot({ pin: "11111111" }),
    ).rejects.toThrow();
    expect(store.getSnapshot().header?.protection?.rootEpoch).toBe(
      before?.protection?.rootEpoch,
    );
  });

  it("refuses to prove a password the vault does not hold", async () => {
    const store = await passkeyVault();
    await expect(
      store.protection.rotateCompromisedRoot({
        password: "correct horse battery staple",
      }),
    ).rejects.toBeInstanceOf(ProtectionError);
  });

  it("refuses a PIN rotation on a vault that holds a password, too", async () => {
    const store = new VaultStore();
    await store.create("correct horse battery staple");
    await store.protection.ensureProtectionProjected();
    const before = store.getSnapshot().header;
    await expect(
      store.protection.rotateCompromisedRoot({ pin: NEW_PIN }),
    ).rejects.toBeInstanceOf(ProtectionError);
    expect(store.getSnapshot().header).toEqual(before);
  });

  it("refuses a passkey rotation on a vault that holds a password, which it would drop", async () => {
    const store = new VaultStore();
    await store.create("correct horse battery staple");
    await store.protection.ensureProtectionProjected();
    await expect(
      store.protection.rotateCompromisedRoot({ passkey: true }),
    ).rejects.toBeInstanceOf(ProtectionError);
  });
});

describe("the files of a vault survive a rotation of its key", () => {
  it("opens a sealed settings file again after the vault is relocked", async () => {
    const store = new VaultStore();
    await store.createWithPin(OLD_PIN);
    const bytes = new Uint8Array([7, 7, 7, 1, 2, 3]);
    await writeFile(PERSONAL_TOMB, "settings/probe", bytes);
    await store.protection.ensureProtectionProjected();
    await store.protection.rotateCompromisedRoot({ pin: NEW_PIN });
    // Still readable in the session that rotated.
    expect(await readFile(PERSONAL_TOMB, "settings/probe")).toEqual(bytes);
    store.lock();

    const reopened = new VaultStore();
    await reopened.unlockWithPin(NEW_PIN);
    expect(await readFile(PERSONAL_TOMB, "settings/probe")).toEqual(bytes);
  });

  it("opens them for a vault that proves its password, too", async () => {
    const password = "correct horse battery staple";
    const store = new VaultStore();
    await store.create(password);
    const bytes = new Uint8Array([9, 8, 7]);
    await writeFile(PERSONAL_TOMB, "settings/probe", bytes);
    await store.protection.ensureProtectionProjected();
    await store.protection.rotateCompromisedRoot({ password });
    store.lock();

    const reopened = new VaultStore();
    await reopened.unlock(password);
    expect(await readFile(PERSONAL_TOMB, "settings/probe")).toEqual(bytes);
  });
});

describe("a rotation that fails part-way puts the vault back", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Make one stored key refuse to be written, as a full disk would. */
  function failWritesTo(suffix: string): void {
    const write = vfsSeams.writeRaw;
    vi.spyOn(vfsSeams, "writeRaw").mockImplementation(async (key, value) => {
      if (key.endsWith(suffix)) throw new Error("disk full");
      return write(key, value);
    });
  }

  async function pinVaultWithFile(bytes: Uint8Array): Promise<VaultStore> {
    const store = new VaultStore();
    await store.createWithPin(OLD_PIN);
    await writeFile(PERSONAL_TOMB, "settings/probe", bytes);
    await store.protection.ensureProtectionProjected();
    return store;
  }

  async function stillOpensWithTheOldPin(bytes: Uint8Array): Promise<void> {
    vi.restoreAllMocks();
    const reopened = new VaultStore();
    await reopened.unlockWithPin(OLD_PIN);
    expect(reopened.getSnapshot().status).toBe("unlocked");
    expect(await readFile(PERSONAL_TOMB, "settings/probe")).toEqual(bytes);
  }

  it("keeps the old key when the new header cannot be written", async () => {
    const bytes = new Uint8Array([4, 4, 4]);
    const store = await pinVaultWithFile(bytes);
    failWritesTo("/header");
    await expect(
      store.protection.rotateCompromisedRoot({ pin: NEW_PIN }),
    ).rejects.toThrow(/disk full/);
    // The session that failed still reads what it had.
    expect(await readFile(PERSONAL_TOMB, "settings/probe")).toEqual(bytes);
    store.lock();
    await stillOpensWithTheOldPin(bytes);
  });

  it("keeps the old key when the index cannot be written after a file was, with no file left under the new one", async () => {
    const bytes = new Uint8Array([5, 5]);
    const store = await pinVaultWithFile(bytes);
    failWritesTo("/index");
    await expect(
      store.protection.rotateCompromisedRoot({ pin: NEW_PIN }),
    ).rejects.toThrow(/disk full/);
    store.lock();
    await stillOpensWithTheOldPin(bytes);
  });
});
