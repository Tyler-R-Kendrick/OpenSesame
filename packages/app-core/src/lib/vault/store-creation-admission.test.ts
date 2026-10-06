import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { webLocksDouble } from "../__tests__/web-locks-double.js";
import { isDecoySession } from "../decoy-session.js";
import { kvForgetAll } from "../kv.js";
import {
  HEADER_PATH,
  readPlaintextFile,
  tombFileKey,
  tombUnlocked,
  vfsFlush,
  vfsSeams,
} from "../vfs.js";
import { verifyManifestAuth } from "./protection/manifest-auth.js";
import * as creation from "./store-creation.js";
import { VaultStore } from "./store.js";
import { unwrapVaultKeyWithPin } from "./unlock-methods.js";

const stores: VaultStore[] = [];
beforeEach(async () => {
  await vfsFlush();
  kvForgetAll();
  vi.stubGlobal("navigator", { locks: webLocksDouble() });
});
afterEach(() => {
  for (const store of stores.splice(0)) store.lock();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function newStore() {
  const store = new VaultStore();
  stores.push(store);
  return store;
}
function observeRaw() {
  const copies: Uint8Array[] = [];
  const original = crypto.subtle.importKey.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, "importKey").mockImplementation(async (...args) => {
    if (
      args[0] === "raw" &&
      args[2] === "HKDF" &&
      args[1] instanceof Uint8Array
    )
      copies.push(args[1]);
    return original(...args);
  });
  return copies;
}
function blockFirstGenuineMac() {
  let reached = () => {};
  let release = () => {};
  const started = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const sign = crypto.subtle.sign.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, "sign").mockImplementationOnce(async (...args) => {
    const tag = await sign(...args);
    reached();
    await blocked;
    return tag;
  });
  return { started, release };
}

it.each(["lock", "synthetic", "successor-real"] as const)(
  "withholds the first authenticated header and original root after %s supersedes actual creation crypto",
  async (transition) => {
    const store = newStore();
    const rawCopies = observeRaw();
    const gate = blockFirstGenuineMac();
    const result = store.create("first actual originating owner").then(
      () => null,
      (error: Error) => error,
    );
    await gate.started;
    expect(store.isUnlocked()).toBe(false);
    expect(store.getSnapshot().header).toBeNull();
    expect(tombUnlocked("personal")).toBe(false);
    expect(readPlaintextFile("personal", HEADER_PATH)).toBeNull();
    const originalCopies = [...rawCopies];
    expect(originalCopies.length).toBeGreaterThan(0);
    store.lock();
    if (transition === "synthetic")
      await store.createGuest({ isolated: true, decoy: true });
    if (transition === "successor-real") await store.createWithPin("48629175");
    const successor = store.getSnapshot();
    const durable = readPlaintextFile("personal", HEADER_PATH);
    gate.release();
    expect(await result).toBeInstanceOf(Error);
    expect(store.getSnapshot()).toEqual(successor);
    expect(readPlaintextFile("personal", HEADER_PATH)).toBe(durable);
    expect(originalCopies.every((raw) => raw.every((byte) => byte === 0))).toBe(
      true,
    );
    if (transition === "synthetic") expect(isDecoySession()).toBe(true);
    if (transition === "successor-real") {
      store.lock();
      await store.unlockWithPin("48629175");
      expect(store.isUnlocked()).toBe(true);
    }
  },
);

it("leaves no admitted root or first header after durable publication fails and wipes the original bytes", async () => {
  const store = newStore();
  const copies = observeRaw();
  const write = vfsSeams.writeRaw;
  vi.spyOn(vfsSeams, "writeRaw").mockImplementation(async (key, value) => {
    if (key === tombFileKey("personal", HEADER_PATH))
      throw new Error("durable header write refused");
    return write(key, value);
  });
  await expect(
    store.create("actual owner first publication failure"),
  ).rejects.toThrow("durable header write refused");
  expect(store.isUnlocked()).toBe(false);
  expect(store.getSnapshot().header).toBeNull();
  expect(tombUnlocked("personal")).toBe(false);
  expect(readPlaintextFile("personal", HEADER_PATH)).toBeNull();
  expect(copies.length).toBeGreaterThan(0);
  expect(copies.every((raw) => raw.every((byte) => byte === 0))).toBe(true);
});

it("authenticates the first PIN-only header with its actual wrapped root and keeps its identity through genuine reopen", async () => {
  const store = newStore();
  await store.createWithPin("48629175");
  const header = store.getSnapshot().header;
  if (!header?.unlocks?.pin || !header.protection)
    throw new Error("Expected authenticated PIN owner");
  const raw = await unwrapVaultKeyWithPin(header.unlocks.pin, "48629175");
  try {
    await verifyManifestAuth(raw, header.protection);
  } finally {
    raw.fill(0);
  }
  store.lock();
  await store.unlockWithPin("48629175");
  expect(store.getSnapshot().header?.protection?.vaultId).toBe(
    header.protection.vaultId,
  );
  expect(store.getSnapshot().header?.protection?.rootKeyId).toBe(
    header.protection.rootKeyId,
  );
});

// The helper and its caller resume in separate microtasks: genuine crypto can
// finish before a queued lock, while the caller has not yet admitted the root.
it("rejects a public lock in the genuine header helper's return microtask", async () => {
  const store = newStore();
  const copies = observeRaw();
  const original = creation.sealNewHeader;
  vi.spyOn(creation, "sealNewHeader").mockImplementation(async (...args) => {
    const header = await original(...args);
    queueMicrotask(() => store.lock());
    return header;
  });
  await expect(
    store.create("actual helper return-gap owner"),
  ).rejects.toThrow();
  expect(store.isUnlocked()).toBe(false);
  expect(store.getSnapshot().header).toBeNull();
  expect(tombUnlocked("personal")).toBe(false);
  expect(readPlaintextFile("personal", HEADER_PATH)).toBeNull();
  expect(copies.length).toBeGreaterThan(0);
  expect(copies.every((raw) => raw.every((byte) => byte === 0))).toBe(true);
});
