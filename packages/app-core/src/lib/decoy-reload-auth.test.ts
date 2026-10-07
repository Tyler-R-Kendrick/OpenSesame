import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { configureHost } from "../host.js";
import { createMemoryStorage } from "../memory-storage.js";
import { nodeOriginFiles } from "../node/origin-files.js";
import { createTestHost } from "../test-host.js";
import {
  PASSWORD,
  clearVaultSurface,
} from "./vault/protection/protector-enrollment.test-support.js";
import { VaultStore } from "./vault/store.js";
import { vfsFlush } from "./vfs.js";

let store: VaultStore | undefined;
let directory = "";
afterEach(() => {
  store?.lock();
  vi.restoreAllMocks();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

it("restores the tab's pending original-owner admission after a normal module reload", async () => {
  directory = mkdtempSync(join(tmpdir(), "decoy-reload-proof-"));
  configureHost(
    createTestHost({
      originFiles: nodeOriginFiles(directory),
      storage: { local: createMemoryStorage(), session: createMemoryStorage() },
    }),
  );
  await clearVaultSurface();
  store = new VaultStore();
  await store.create(PASSWORD);
  store.lock();
  await store.unlock(PASSWORD);
  store.lock();
  await store.createGuest({ decoy: true, resume: false });
  store.lock();
  await store.flushPendingWrites();
  await vfsFlush();
  // Keep the actual host and its session storage; only module memory is lost,
  // as happens when this tab loads the application again.
  vi.resetModules();
  const realm = await import("./decoy-session.js");
  const identity = await import("./identity.js");
  const host = vi
    .spyOn(identity.identitySeams, "hostFetch")
    .mockResolvedValue(new Response("member data"));
  const remote = vi
    .spyOn(identity.identitySeams, "identityFetch")
    .mockResolvedValue(new Response("identity data"));
  expect(realm.requiresFreshOwnerAuthentication()).toBe(true);
  expect(identity.currentSession()).toBeNull();
  await expect(identity.hostFetch("/api/v1/member")).rejects.toThrow(
    /authenticate again/,
  );
  await expect(identity.identityFetch("/v1/principals/me")).rejects.toThrow(
    /authenticate again/,
  );
  expect(host).not.toHaveBeenCalled();
  expect(remote).not.toHaveBeenCalled();
  const { atRestReady } = await import("./at-rest/key.js");
  await atRestReady();
  const { kvHydrate } = await import("./kv.js");
  const { tombStorageKeys } = await import("./vault/tomb-migration.js");
  await kvHydrate(tombStorageKeys("personal"));
  const fresh = await import("./vault/store.js");
  const owner = new fresh.VaultStore();
  await owner.unlock(PASSWORD);
  expect(realm.requiresFreshOwnerAuthentication()).toBe(false);
  await expect(identity.hostFetch("/api/v1/member")).resolves.toBeInstanceOf(
    Response,
  );
  expect(host).toHaveBeenCalledTimes(1);
  owner.lock();
});
