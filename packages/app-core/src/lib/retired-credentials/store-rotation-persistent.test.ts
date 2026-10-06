import {
  createItem,
  importVaultKey,
  openJson,
  unwrapRawVaultKeyFromPassword,
  vaultSealBinding,
} from "@opensesame/vault-core";
import { afterEach, expect, it, vi } from "vitest";
import { configureHost } from "../../host.js";
import { createTestHost } from "../../test-host.js";
import { webLocksDouble } from "../__tests__/web-locks-double.js";
import { makeOpfs } from "../duress/wipe/fake-opfs.test-support.js";
const PASSWORD = "correct horse battery staple";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  configureHost(createTestHost());
});
it("refreshes genuine shared persistent storage inside the write lock and rejects a second tab's stale cached root", async () => {
  const root = makeOpfs();
  const locks = webLocksDouble();
  vi.stubGlobal("navigator", {
    storage: { getDirectory: async () => root },
    locks,
  });
  const atRestKey = crypto.getRandomValues(new Uint8Array(32));
  configureHost(
    createTestHost({
      atRestKeys: { loadSync: () => atRestKey, load: async () => atRestKey },
    }),
  );
  const firstKv = await import("../kv.js");
  const firstFiles = await import("../vfs.js");
  const { VaultStore } = await import("../vault/store.js");
  const old = new VaultStore();
  await old.create(PASSWORD);
  old.lock();
  await old.unlock(PASSWORD);
  await firstFiles.writeFile(
    "personal",
    "proof/private.txt",
    new TextEncoder().encode("preserved file"),
  );
  const header = old.getSnapshot().header;
  if (!header) throw new Error("Expected protected owner header");
  const previousHeader = firstKv.kvGet(
    firstFiles.tombFileKey("personal", firstFiles.HEADER_PATH),
  );
  const raw = await unwrapRawVaultKeyFromPassword(header, PASSWORD);
  const oldKey = await importVaultKey(raw);
  raw.fill(0);
  // A separate module registry gives tab B independent KV and admission maps over the SAME durable OPFS and locks.
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
  await current.protection.rotateCompromisedRoot({ password: PASSWORD });
  expect(
    firstKv.kvGet(firstFiles.tombFileKey("personal", firstFiles.HEADER_PATH)),
  ).toBe(previousHeader);
  const durable = new Map(root.files);
  await expect(
    firstFiles.writeFile("personal", "proof/private.txt", new Uint8Array([9])),
  ).rejects.toMatchObject({ code: "locked" });
  await expect(
    old.saveItem(createItem("note", "stale owner write")),
  ).rejects.toThrow();
  expect(root.files).toEqual(durable);
  expect(
    new TextDecoder().decode(
      await currentFiles.readFile("personal", "proof/private.txt"),
    ),
  ).toBe("preserved file");
  const sealed = currentFiles.readSealedFile("personal", "proof/private.txt");
  if (!sealed) throw new Error("Expected rotated seal");
  await expect(
    openJson(oldKey, sealed, vaultSealBinding("personal", "proof/private.txt")),
  ).rejects.toThrow();
  expect(locks.requested).toContain("opensesame:vfs-rotation:personal");
  old.lock();
  current.lock();
});

it("preserves a concurrent same-root password change when an older tab advances the body witness", async () => {
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
  const firstFiles = await import("../vfs.js");
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
  const replacementPassword = "new correct horse battery staple";
  await current.unlock(PASSWORD);
  await current.changeMasterPassword(PASSWORD, replacementPassword);
  const replacement = current.getSnapshot().header;
  if (!replacement?.wrap)
    throw new Error("Expected current owner password wrap");
  const item = createItem("note", "Accepted same-root owner write");
  await old.saveItem(item);
  expect(
    firstFiles.readPlaintextFile("personal", firstFiles.HEADER_PATH),
  ).toContain(JSON.stringify(replacement.wrap));
  old.lock();
  current.lock();
  await currentKv.kvHydrate(
    [
      currentFiles.HEADER_PATH,
      currentFiles.BODY_PATH,
      currentFiles.INDEX_PATH,
    ].map((path) => currentFiles.tombFileKey("personal", path)),
  );
  const reopened = new CurrentStore();
  await expect(reopened.unlock(PASSWORD)).rejects.toThrow();
  await reopened.unlock(replacementPassword);
  expect(
    reopened.getSnapshot().items.some((entry) => entry.id === item.id),
  ).toBe(true);
  reopened.lock();
});
