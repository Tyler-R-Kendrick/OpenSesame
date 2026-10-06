import { overlapCast } from "@opensesame/os-domain";
import { memoryObjectStore } from "@opensesame/vault-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { configureHost } from "../../host.js";
import { createTestHost } from "../../test-host.js";
import { resetRealmFixture } from "../__tests__/reset-realm-fixture.js";
import { markDecoySession } from "../decoy-session.js";
import { localFileStore } from "../file-parts-store.js";
import { vaultStore } from "../vault/store.js";
import { vfsSeams } from "../vfs.js";
import { adoptSnapshot } from "./adopt.js";
import { driveClientSeams, reachDrive } from "./client.js";
import { PAIRING, memoryDrive } from "./drive.fixture.js";
import { syncOnce } from "./engine.js";
import { networkAccessSeams } from "./network-access.js";
import {
  pairTailnetDrive,
  syncTailnetNow,
  tailnetSyncSeams,
} from "./observer.js";
import { formatPairingCode } from "./pairing.js";
import {
  driveFileStore,
  listDriveParts,
  readDrivePart,
  writeDrivePart,
} from "./parts.js";
import {
  bindTailnetConnector,
  boundTailnet,
  currentTailnet,
} from "./saved-connector.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve: (value: T) => resolve(value) };
}

const seams = { ...tailnetSyncSeams };
const query = networkAccessSeams.query;
const fetch = driveClientSeams.fetch;
beforeEach(() => {
  markDecoySession(false);
  configureHost(createTestHost());
});
afterEach(() => {
  markDecoySession(false);
  Object.assign(tailnetSyncSeams, seams);
  networkAccessSeams.query = query;
  driveClientSeams.fetch = fetch;
  bindTailnetConnector(null);
  vi.restoreAllMocks();
});

it("does not recapture successor authority after a pairing permission wait", async () => {
  const permission = deferred<"prompt">();
  networkAccessSeams.query = () => permission.promise;
  const reach = vi.fn(async () => undefined);
  const read = vi.fn(async () => ({ generation: 0, snapshot: null }));
  tailnetSyncSeams.reach = reach;
  tailnetSyncSeams.transport = { read, write: vi.fn() };
  const pending = pairTailnetDrive(formatPairingCode(PAIRING));
  markDecoySession(true);
  markDecoySession(false);
  permission.resolve("prompt");
  await expect(pending).rejects.toThrow(/authenticate again/);
  expect(reach).not.toHaveBeenCalled();
  expect(read).not.toHaveBeenCalled();
});

it("pins the full sync even when its transport is injected", async () => {
  const response = deferred<{ generation: number; snapshot: null }>();
  const vault = { mergeSnapshot: vi.fn(), sealedSnapshot: vi.fn() };
  const write = vi.fn();
  const pending = syncOnce(vault, PAIRING, {
    read: () => response.promise,
    write,
  });
  markDecoySession(true);
  markDecoySession(false);
  response.resolve({ generation: 0, snapshot: null });
  await expect(pending).rejects.toThrow(/authenticate again/);
  expect(vault.sealedSnapshot).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
});

it("rejects direct synthetic adoption, connector secret reads and attachment requests", async () => {
  bindTailnetConnector({
    providerId: "tailscale",
    operation: "sync",
    fields: {},
    secret: { auth_key: "owner-key" },
  });
  const transport = vi.fn();
  driveClientSeams.fetch = transport;
  const write = vi.spyOn(vfsSeams, "writeRaw");
  markDecoySession(true);
  expect(() => boundTailnet()).toThrow(/authenticate again/);
  expect(() => currentTailnet()).toThrow(/authenticate again/);
  await expect(adoptSnapshot(overlapCast({}))).rejects.toThrow(
    /authenticate again/,
  );
  await expect(reachDrive(PAIRING, 120000)).rejects.toThrow(
    /authenticate again/,
  );
  await expect(listDriveParts(PAIRING)).rejects.toThrow(/authenticate again/);
  await expect(readDrivePart(PAIRING, "key")).rejects.toThrow(
    /authenticate again/,
  );
  await expect(
    writeDrivePart(PAIRING, "key", new Uint8Array()),
  ).rejects.toThrow(/authenticate again/);
  expect(transport).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
});

it("withholds in-flight bytes and invalidates retained drive handles after decoy exit", async () => {
  const body = deferred<ArrayBuffer>();
  driveClientSeams.fetch = vi.fn(async () =>
    overlapCast({ ok: true, status: 200, arrayBuffer: () => body.promise }),
  );
  const local = memoryObjectStore();
  const put = vi.spyOn(local, "putObject");
  const store = driveFileStore(PAIRING, local);
  const pending = store.getObject("key");
  await Promise.resolve();
  await Promise.resolve();
  markDecoySession(true);
  markDecoySession(false);
  body.resolve(new Uint8Array([42]).buffer);
  await expect(pending).rejects.toThrow(/authenticate again/);
  expect(put).not.toHaveBeenCalled();
  await expect(store.getObject("key")).rejects.toThrow(/authenticate again/);
  await expect(store.putObject("key", new Uint8Array())).rejects.toThrow(
    /authenticate again/,
  );
});

it("invalidates retained local OPFS handles before they touch owner storage", async () => {
  const getFileHandle = vi.fn();
  configureHost(
    createTestHost({
      originFiles: async () =>
        overlapCast({ getDirectoryHandle: async () => ({ getFileHandle }) }),
    }),
  );
  const store = await localFileStore();
  markDecoySession(true);
  markDecoySession(false);
  await expect(store.getObject("abcdefghijklmnop")).rejects.toThrow(
    /authenticate again/,
  );
  await expect(
    store.putObject("abcdefghijklmnop", new Uint8Array()),
  ).rejects.toThrow(/authenticate again/);
  expect(getFileHandle).not.toHaveBeenCalled();
});

it("discards a paired pass before transport when its permission query outlives the realm", async () => {
  const drive = memoryDrive();
  tailnetSyncSeams.transport = drive;
  networkAccessSeams.query = async () => "granted";
  await vaultStore.create("owner password for tailnet isolation");
  try {
    await pairTailnetDrive(formatPairingCode(PAIRING));
    const permission = deferred<"granted">();
    networkAccessSeams.query = () => permission.promise;
    const read = vi.spyOn(drive, "read");
    const previousWrites = drive.writes;
    const pending = syncTailnetNow({ interactive: true });
    markDecoySession(true);
    markDecoySession(false);
    permission.resolve("granted");
    await pending;
    expect(read).not.toHaveBeenCalled();
    expect(drive.writes).toBe(previousWrites);
  } finally {
    vaultStore.lock();
    resetRealmFixture();
    await vaultStore.unlock("owner password for tailnet isolation");
    await vaultStore.destroy();
  }
});
