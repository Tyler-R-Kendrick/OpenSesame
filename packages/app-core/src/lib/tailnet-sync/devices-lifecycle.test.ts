import { getEventListeners } from "node:events";
import { createItem } from "@opensesame/vault-core";
import { expect, it, onTestFinished, vi } from "vitest";
import { configureHost, host } from "../../host.js";
import { createTestHost } from "../../test-host.js";
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
