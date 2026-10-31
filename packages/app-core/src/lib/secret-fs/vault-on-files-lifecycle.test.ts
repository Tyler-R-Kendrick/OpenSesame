import { getEventListeners } from "node:events";
import { afterEach, beforeEach, expect, it } from "vitest";
import { configureHost, host } from "../../host.js";
import { createTestHost } from "../../test-host.js";
import { resetVaultDestroyChannelForTest } from "../vault/lock-events.js";
import type { VaultStore } from "../vault/store.js";
import { makeMemorySecretFiles } from "./memory.js";
import {
  PASSWORD,
  processOver,
  secret,
  startProcess,
  tree,
} from "./vault-on-files.support.js";

let previousHost = host();
const channels: BroadcastChannel[] = [];
let destroyChannel: BroadcastChannel | undefined;

function listeners(): number {
  return destroyChannel
    ? getEventListeners(destroyChannel, "message").length
    : 0;
}

beforeEach(() => {
  previousHost = host();
  resetVaultDestroyChannelForTest();
  configureHost(
    createTestHost({
      broadcast(name) {
        const channel = new BroadcastChannel(name);
        channels.push(channel);
        if (name === "opensesame.vault-destroy.v1") destroyChannel = channel;
        return channel;
      },
    }),
  );
});

afterEach(() => {
  const remaining = listeners();
  resetVaultDestroyChannelForTest();
  for (const channel of channels.splice(0)) channel.close();
  destroyChannel = undefined;
  configureHost(previousHost);
  expect(remaining).toBe(0);
});

it("ends the former owner at each restart and the final owner at process exit", async () => {
  const inProcess = processOver(async () => ({
    files: makeMemorySecretFiles(),
  }));
  let current: VaultStore | undefined;
  await inProcess(async (_files, restart, newStore) => {
    current = newStore();
    await current.create(PASSWORD);
    await current.saveItem(secret("retained", "sealed value"));
    expect(listeners()).toBe(1);
    for (let cycle = 0; cycle < 12; cycle += 1) {
      const former = current;
      current = await restart();
      expect(former.isUnlocked()).toBe(false);
      expect(former.getSnapshot().items).toEqual([]);
      expect(current.getSnapshot().items).toMatchObject([
        { name: "retained", value: "sealed value" },
      ]);
      expect(listeners()).toBe(1);
    }
  });
  expect(current?.isUnlocked()).toBe(false);
  expect(listeners()).toBe(0);
});

it("releases all owners and storage even when the process body fails", async () => {
  let cleanups = 0;
  const inProcess = processOver(async () => ({
    files: makeMemorySecretFiles(),
    cleanup: () => {
      cleanups += 1;
    },
  }));
  const stores: VaultStore[] = [];
  const failure = new Error("process body failed");
  await expect(
    inProcess(async (_files, _restart, newStore) => {
      const first = newStore();
      stores.push(first);
      await first.create(PASSWORD);
      const second = newStore();
      stores.push(second);
      await second.unlock(PASSWORD);
      expect(listeners()).toBe(2);
      throw failure;
    }),
  ).rejects.toBe(failure);
  expect(stores.every((store) => !store.isUnlocked())).toBe(true);
  expect(listeners()).toBe(0);
  expect(cleanups).toBe(1);
});

it("cancels queued work on abrupt exit without flushing it into the directory", async () => {
  const files = makeMemorySecretFiles();
  const process = await startProcess(files);
  try {
    const store = process.newStore();
    await store.create(PASSWORD);
    const before = await tree(files);
    const refused = expect(
      store.saveItem(secret("uncommitted")),
    ).rejects.toThrow();
    process.stop();
    expect(store.isUnlocked()).toBe(false);
    expect(listeners()).toBe(0);
    expect(() => process.newStore()).toThrow("process has ended");
    await refused;
    expect(await tree(files)).toEqual(before);
    process.stop();
    expect(listeners()).toBe(0);
  } finally {
    process.stop();
  }
});
