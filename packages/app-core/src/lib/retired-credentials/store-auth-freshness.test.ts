import { createItem, parseTotp, totpCode } from "@opensesame/vault-core";
import { afterEach, expect, it, vi } from "vitest";
import { configureHost } from "../../host.js";
import { createTestHost } from "../../test-host.js";
import { webLocksDouble } from "../__tests__/web-locks-double.js";
import { makeOpfs } from "../duress/wipe/fake-opfs.test-support.js";

const PASSWORD = "correct horse battery staple";
const REPLACEMENT = "different current owner password";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  configureHost(createTestHost());
});

async function twoTabs() {
  vi.resetModules();
  const root = makeOpfs();
  vi.stubGlobal("navigator", {
    storage: { getDirectory: async () => root },
    locks: webLocksDouble(),
  });
  const atRestKey = crypto.getRandomValues(new Uint8Array(32));
  configureHost(
    createTestHost({
      atRestKeys: { loadSync: () => atRestKey, load: async () => atRestKey },
    }),
  );
  const oldKv = await import("../kv.js");
  const oldFiles = await import("../vfs.js");
  const oldUnwrap = await import("../vault/primary-unwrap.js");
  const { VaultStore } = await import("../vault/store.js");
  const old = new VaultStore();
  await old.create(PASSWORD);
  old.lock();
  await old.unlock(PASSWORD);
  vi.resetModules();
  const currentKv = await import("../kv.js");
  const currentFiles = await import("../vfs.js");
  await currentKv.kvHydrate(
    ["header", "body", "index", "migrated.v1", "seal-bound.v1"].map((path) =>
      currentFiles.tombFileKey("personal", path),
    ),
  );
  const { VaultStore: CurrentStore } = await import("../vault/store.js");
  const current = new CurrentStore();
  await current.unlock(PASSWORD);
  return {
    root,
    old,
    current,
    oldKv,
    oldFiles,
    oldUnwrap,
    currentKv,
    currentFiles,
  };
}

it("refuses persistent authentication without the cross-tab lock boundary", async () => {
  const { old, root } = await twoTabs();
  old.lock();
  vi.stubGlobal("navigator", { storage: { getDirectory: async () => root } });
  await expect(old.unlock(PASSWORD)).rejects.toThrow(/Web Locks/);
  expect(old.getSnapshot().status).toBe("locked");
});

it("does not publish a validly unwrapped root whose current durable body fails authentication", async () => {
  const { old, currentKv, currentFiles, oldFiles } = await twoTabs();
  currentKv.kvSet(
    currentFiles.tombFileKey("personal", "body"),
    JSON.stringify({ ivB64: "AAAAAAAAAAAAAAAA", ctB64: "AAAA" }),
  );
  await currentKv.kvFlush();
  old.lock();
  await expect(old.unlock(PASSWORD)).rejects.toThrow();
  expect(old.getSnapshot().status).toBe("locked");
  await expect(
    oldFiles.readFile("personal", "proof/private.txt"),
  ).rejects.toMatchObject({ code: "locked" });
});

it("cannot turn a deleted owner's header into a first ephemeral enrollment", async () => {
  const { current, currentKv, currentFiles } = await twoTabs();
  const path = currentFiles.tombFileKey("personal", "header");
  currentKv.kvDelete(path);
  await currentKv.kvFlush();
  await expect(current.enrollPin("48291037")).rejects.toThrow();
  expect(currentKv.kvGet(path)).toBeNull();
  current.lock();
});

it("rejects a retained old owner policy during enrollment instead of overwriting its peer's new verifier", async () => {
  const { old, current, currentKv, currentFiles } = await twoTabs();
  await current.changeMasterPassword(PASSWORD, REPLACEMENT);
  const path = currentFiles.tombFileKey("personal", "header");
  const durable = currentKv.kvGet(path);
  await expect(old.enrollPin("48291037")).rejects.toThrow();
  await currentKv.kvRefresh(path, 1024 * 1024);
  expect(currentKv.kvGet(path)).toBe(durable);
  old.lock();
  current.lock();
});

it("withholds public sealed-file authority until the real body proof commits", async () => {
  const { old, oldFiles } = await twoTabs();
  await oldFiles.writeFile(
    "personal",
    "proof/private.txt",
    new TextEncoder().encode("Owner-only contents"),
  );
  old.lock();
  let reached = () => {};
  let release = () => {};
  const started = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = crypto.subtle.decrypt.bind(crypto.subtle);
  let captured = false;
  vi.spyOn(crypto.subtle, "decrypt").mockImplementation(async (...args) => {
    const clear = await original(...args);
    if (!captured && new TextDecoder().decode(clear).includes('"items"')) {
      captured = true;
      reached();
      await blocked;
    }
    return clear;
  });
  const pending = old.unlock(PASSWORD);
  await started;
  expect(old.getSnapshot().status).toBe("locked");
  await expect(
    oldFiles.readFile("personal", "proof/private.txt"),
  ).rejects.toMatchObject({ code: "locked" });
  release();
  await pending;
  expect(
    new TextDecoder().decode(
      await oldFiles.readFile("personal", "proof/private.txt"),
    ),
  ).toBe("Owner-only contents");
  old.lock();
});

it("rejects the revoked password in a stale independent tab after a durable same-root password change", async () => {
  const fixture = await twoTabs();
  const { old, current, oldKv, oldFiles, currentKv, currentFiles } = fixture;
  await current.changeMasterPassword(PASSWORD, REPLACEMENT);
  const path = oldFiles.tombFileKey("personal", oldFiles.HEADER_PATH);
  expect(oldKv.kvGet(path)).not.toEqual(currentKv.kvGet(path));
  current.lock();
  await current.unlock(REPLACEMENT);
  expect(current.getSnapshot().status).toBe("unlocked");
  old.lock();
  await expect(old.unlock(PASSWORD)).rejects.toThrow();
  expect(old.getSnapshot().status).toBe("locked");
  expect(currentFiles.readPlaintextFile("personal", "header")).toContain(
    JSON.stringify(current.getSnapshot().header?.wrap),
  );
  current.lock();
});

it("requires the newly enrolled durable TOTP factor in a stale independent tab", async () => {
  const { old, current } = await twoTabs();
  const uri = await current.beginTotpEnrollment();
  const secret = new URL(uri).searchParams.get("secret") ?? "";
  await current.confirmTotpEnrollment(await totpCode(parseTotp(secret)));
  const selfId = current.getSnapshot().header?.unlocks?.totp?.selfItemId;
  if (!selfId) throw new Error("Expected the actual enrolled authenticator");
  await current.trashItem(selfId);
  current.lock();
  await current.unlock(PASSWORD);
  expect(current.getSnapshot().awaitingSecondStep).toBe(true);
  old.lock();
  await old.unlock(PASSWORD);
  expect(old.getSnapshot().awaitingSecondStep).toBe(true);
  expect(old.getSnapshot().status).toBe("locked");
  await old.confirmTotp(await totpCode(parseTotp(secret)));
  expect(old.getSnapshot().status).toBe("unlocked");
  old.lock();
  current.lock();
});

it("withholds an actual password root if its durable verifier is revoked while primary proof awaits", async () => {
  const { old, current, oldUnwrap, oldFiles } = await twoTabs();
  old.lock();
  let reached = () => {};
  let release = () => {};
  const started = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = oldUnwrap.unwrapSeams.password;
  let raw: Uint8Array | null = null;
  vi.spyOn(oldUnwrap.unwrapSeams, "password").mockImplementationOnce(
    async (header, password) => {
      raw = await original(header, password);
      reached();
      await blocked;
      return raw;
    },
  );
  const pending = old.unlock(PASSWORD);
  const result = pending.then(
    () => null,
    (error: Error) => error,
  );
  await started;
  expect(old.getSnapshot().status).toBe("locked");
  await expect(
    oldFiles.readFile("personal", oldFiles.BODY_PATH),
  ).rejects.toMatchObject({ code: "locked" });
  await current.changeMasterPassword(PASSWORD, REPLACEMENT);
  release();
  expect(await result).toBeInstanceOf(Error);
  expect(old.getSnapshot().status).toBe("locked");
  if (!raw) throw new Error("Expected an actual cryptographic root proof");
  expect(Array.from(raw)).toEqual(Array.from({ length: 32 }, () => 0));
  current.lock();
});

it.each(["deleted", "corrupt"])(
  "fails closed on a %s durable authentication header despite a valid cached verifier",
  async (state) => {
    const { old, currentKv, currentFiles } = await twoTabs();
    const path = currentFiles.tombFileKey("personal", "header");
    if (state === "deleted") currentKv.kvDelete(path);
    else currentKv.kvSet(path, "{broken authentication header");
    await currentKv.kvFlush();
    old.lock();
    await expect(old.unlock(PASSWORD)).rejects.toThrow();
    expect(old.getSnapshot().status).not.toBe("unlocked");
  },
);

it("preserves a session already admitted under its current factors when a peer later enrolls another factor", async () => {
  const { old, current, oldFiles } = await twoTabs();
  await oldFiles.writeFile(
    "personal",
    "proof/private.txt",
    new TextEncoder().encode("Actual owner file"),
  );
  old.lock();
  let reached = () => {};
  let release = () => {};
  const started = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = old.protection.ensureProtectionProjected.bind(
    old.protection,
  );
  vi.spyOn(old.protection, "ensureProtectionProjected").mockImplementationOnce(
    async () => {
      await original();
      reached();
      await blocked;
    },
  );
  const result = old.unlock(PASSWORD).then(
    () => null,
    (error: Error) => error,
  );
  await started;
  // The session has already authenticated the real body and committed its principal before housekeeping.
  await expect(
    oldFiles.readFile("personal", "proof/private.txt"),
  ).resolves.toBeInstanceOf(Uint8Array);
  const uri = await current.beginTotpEnrollment();
  const secret = new URL(uri).searchParams.get("secret") ?? "";
  await current.confirmTotpEnrollment(await totpCode(parseTotp(secret)));
  release();
  expect(await result).toBeNull();
  expect(old.getSnapshot().status).toBe("unlocked");
  old.lock();
  current.lock();
});

it("rejects an actual pending factor proof when a peer revokes its primary verifier", async () => {
  const { old, current } = await twoTabs();
  const uri = await current.beginTotpEnrollment();
  const secret = new URL(uri).searchParams.get("secret") ?? "";
  await current.confirmTotpEnrollment(await totpCode(parseTotp(secret)));
  const selfId = current.getSnapshot().header?.unlocks?.totp?.selfItemId;
  if (!selfId) throw new Error("Expected actual enrolled TOTP");
  await current.trashItem(selfId);
  old.lock();
  await old.unlock(PASSWORD);
  expect(old.getSnapshot().awaitingSecondStep).toBe(true);
  let reached = () => {};
  let release = () => {};
  const started = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = crypto.subtle.decrypt.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, "decrypt").mockImplementationOnce(async (...args) => {
    const clear = await original(...args);
    reached();
    await blocked;
    return clear;
  });
  const code = await totpCode(parseTotp(secret));
  const result = old.confirmTotp(code).then(
    () => null,
    (error: Error) => error,
  );
  await started;
  await current.changeMasterPassword(PASSWORD, REPLACEMENT);
  release();
  expect(await result).toBeInstanceOf(Error);
  expect(old.getSnapshot().status).toBe("locked");
  current.lock();
});

it("accepts a legitimate concurrent body-only change while a real primary proof awaits", async () => {
  const { old, current, oldUnwrap } = await twoTabs();
  old.lock();
  let reached = () => {};
  let release = () => {};
  const started = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = oldUnwrap.unwrapSeams.password;
  vi.spyOn(oldUnwrap.unwrapSeams, "password").mockImplementationOnce(
    async (header, password) => {
      const raw = await original(header, password);
      reached();
      await blocked;
      return raw;
    },
  );
  const pending = old.unlock(PASSWORD);
  await started;
  const item = createItem("note", "Concurrent legitimate owner body change");
  await current.saveItem(item);
  release();
  await pending;
  expect(old.getSnapshot().status).toBe("unlocked");
  expect(old.getSnapshot().items).toContainEqual(
    expect.objectContaining({ id: item.id }),
  );
  old.lock();
  current.lock();
});
