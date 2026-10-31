import { getEventListeners } from "node:events";
import { createItem } from "@opensesame/vault-core";
import { expect, it, onTestFinished, vi } from "vitest";
import { configureHost, host } from "../../host.js";
import { createTestHost } from "../../test-host.js";
import { kvGet } from "../kv.js";
import { resetVaultDestroyChannelForTest } from "../vault/lock-events.js";
import { vfsSeams } from "../vfs.js";
import { as, device } from "./devices.fixture.js";

it("keeps concurrent devices active until test exit, then closes each in its own realm", async () => {
  const previousHost = host();
  const channels: BroadcastChannel[] = [];
  let destroyChannel: BroadcastChannel | undefined;
  const broadcast = (name: string) => {
    const channel = new BroadcastChannel(name);
    channels.push(channel);
    if (name === "opensesame.vault-destroy.v1") destroyChannel = channel;
    return channel;
  };
  resetVaultDestroyChannelForTest();
  const closed: string[] = [];
  // Finish hooks run in reverse order; verify after both device owners close.
  const assertClosed = () => {
    expect(laptop.store.isUnlocked()).toBe(false);
    expect(phone.store.isUnlocked()).toBe(false);
    expect(new Set(closed)).toEqual(new Set(["phone", "laptop"]));
    expect(destroyChannel).toBeDefined();
    if (destroyChannel)
      expect(getEventListeners(destroyChannel, "message")).toHaveLength(0);
    expect(host()).toBe(previousHost);
  };
  onTestFinished(() => {
    try {
      assertClosed();
    } finally {
      vi.restoreAllMocks();
      resetVaultDestroyChannelForTest();
      for (const channel of channels) channel.close();
      configureHost(previousHost);
    }
  });
  const laptop = device("laptop");
  const phone = device("phone");
  const laptopHost = createTestHost({ broadcast });
  const phoneHost = createTestHost({ broadcast });
  try {
    for (const [on, context] of [
      [laptop, laptopHost],
      [phone, phoneHost],
    ] as const) {
      configureHost(context);
      await as(on, async () => {
        await on.store.create("correct horse battery staple");
        await on.store.saveItem(createItem("note", on.name));
      });
      const flush = on.store.flushPendingWrites.bind(on.store);
      vi.spyOn(on.store, "flushPendingWrites").mockImplementation(async () => {
        expect(host()).toBe(context);
        expect(vfsSeams.readRaw).toBe(on.seams.readRaw);
        expect(vfsSeams.writeRaw).toBe(on.seams.writeRaw);
        closed.push(on.name);
        await flush();
      });
    }
    expect(laptop.store.isUnlocked()).toBe(true);
    expect(phone.store.isUnlocked()).toBe(true);
    expect(laptop.store.getSnapshot().items[0]?.name).toBe("laptop");
    expect(phone.store.getSnapshot().items[0]?.name).toBe("phone");
    expect(destroyChannel).toBeDefined();
    if (destroyChannel)
      expect(getEventListeners(destroyChannel, "message")).toHaveLength(2);
  } finally {
    configureHost(previousHost);
  }
});

it("commits guarded device writes only to their own realm and refuses a retired publication", async () => {
  const previous = vfsSeams.writeRawGuarded;
  const laptop = device("guarded laptop");
  const phone = device("guarded phone");
  const key = `fixture-guarded-${crypto.randomUUID()}`;
  const globalBefore = kvGet(key);
  await as(laptop, async () => {
    const write = vfsSeams.writeRawGuarded;
    if (!write) throw new Error("Missing device guarded commit capability");
    await write(key, "laptop value", () => {});
    await expect(
      write(key, "retired value", () => {
        throw new Error("Original device owner retired");
      }),
    ).rejects.toThrow(/owner retired/);
    expect(laptop.files.get(key)).toBe("laptop value");
    expect(phone.files.has(key)).toBe(false);
    expect(kvGet(key)).toBe(globalBefore);
  });
  expect(vfsSeams.writeRawGuarded).toBe(previous);
  await as(phone, async () => {
    const write = vfsSeams.writeRawGuarded;
    if (!write) throw new Error("Missing device guarded commit capability");
    await write(key, "phone value", () => {});
    expect(phone.files.get(key)).toBe("phone value");
    expect(laptop.files.get(key)).toBe("laptop value");
    expect(kvGet(key)).toBe(globalBefore);
  });
  expect(vfsSeams.writeRawGuarded).toBe(previous);
});
