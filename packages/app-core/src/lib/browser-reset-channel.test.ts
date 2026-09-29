/**
 * The reset channel is imported by the shell's entry before anything renders,
 * so it must load where `crypto.randomUUID` does not exist (Safari before
 * 15.4, a non-secure context) and make its tab id only when first needed.
 * A tab that hears a reset start stops writing at once and reloads only once
 * it is over: on `done`, when the resetting tab's Web Lock is released, or —
 * without Web Locks — at a generous ceiling.
 */

import { overlapCast } from "@opensesame/os-domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureHost } from "../host.js";
import type { LockManagerLike } from "../ports.js";
import { createTestHost } from "../test-host.js";
import { RESET_LOCK, onBrowserReset } from "./browser-reset-channel.js";
import { broadcastHub } from "./browser-reset.fixture.js";
import { kvSetDurable } from "./kv.js";
import {
  resumeStorageWritesForTest,
  storageWritesHalted,
} from "./storage-halt.js";

const realCrypto = globalThis.crypto;

afterEach(() => {
  vi.useRealTimers();
  resumeStorageWritesForTest();
  vi.unstubAllGlobals();
  vi.resetModules();
  configureHost(createTestHost());
});

describe("browser-reset-channel", () => {
  it("touches no crypto at import", async () => {
    vi.stubGlobal("crypto", {
      get randomUUID(): never {
        throw new Error("read at import");
      },
      get getRandomValues(): never {
        throw new Error("read at import");
      },
    });
    vi.resetModules();

    await expect(import("./browser-reset-channel.js")).resolves.toBeDefined();
  });

  it("makes a tab id without randomUUID, and still tells its own message apart", async () => {
    vi.stubGlobal("crypto", {
      getRandomValues: (bytes: Uint8Array) => realCrypto.getRandomValues(bytes),
    });
    vi.resetModules();
    const { configureHost: install } = await import("../host.js");
    const { createTestHost: testHost } = await import("../test-host.js");
    const hub = broadcastHub();
    install(testHost({ broadcast: hub.open }));
    const channel = await import("./browser-reset-channel.js");
    const heard = vi.fn();
    channel.onBrowserReset(heard);

    channel.announceBrowserReset("done");

    expect(hub.posted).toEqual([
      {
        kind: "reset",
        tab: expect.stringMatching(/^[0-9a-f]{32}$/),
        phase: "done",
      },
    ]);
    expect(heard).not.toHaveBeenCalled();
    hub.open().postMessage({ kind: "reset", tab: "another-tab" });
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it("falls back when randomUUID exists but refuses the call", async () => {
    vi.stubGlobal("crypto", {
      randomUUID: () => {
        throw new DOMException("insecure", "SecurityError");
      },
      getRandomValues: (bytes: Uint8Array) => realCrypto.getRandomValues(bytes),
    });
    vi.resetModules();
    const { configureHost: install } = await import("../host.js");
    const { createTestHost: testHost } = await import("../test-host.js");
    const hub = broadcastHub();
    install(testHost({ broadcast: hub.open }));
    const channel = await import("./browser-reset-channel.js");

    expect(() => channel.announceBrowserReset("start")).not.toThrow();
    expect(hub.posted).toHaveLength(1);
  });
});

describe("hearing another tab's reset", () => {
  it("stops writing at the start and reloads only when it is done", async () => {
    const locks = heldLock();
    const hub = broadcastHub();
    configureHost(createTestHost({ broadcast: hub.open, locks: locks.port }));
    const reload = vi.fn();
    const stop = onBrowserReset(reload);

    hub.open().postMessage({ kind: "reset", tab: "other", phase: "start" });
    expect(storageWritesHalted()).toBe(true);
    await expect(kvSetDurable("settings.v1", "{}")).rejects.toThrow(/reset/);
    expect(reload).not.toHaveBeenCalled();

    hub.open().postMessage({ kind: "reset", tab: "other", phase: "done" });
    expect(reload).toHaveBeenCalledTimes(1);
    stop();
  });

  it("waits for the resetting tab's lock, however long, and reloads when it is released", async () => {
    const locks = heldLock();
    const hub = broadcastHub();
    configureHost(createTestHost({ broadcast: hub.open, locks: locks.port }));
    const reload = vi.fn();
    const stop = onBrowserReset(reload);

    hub.open().postMessage({ kind: "reset", tab: "other", phase: "start" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(locks.asked).toEqual([RESET_LOCK]);
    expect(reload).not.toHaveBeenCalled();

    locks.release();
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    // `done` arriving afterwards does not reload twice.
    hub.open().postMessage({ kind: "reset", tab: "other", phase: "done" });
    expect(reload).toHaveBeenCalledTimes(1);
    stop();
  });

  it("without Web Locks, reloads at the ceiling and not before", () => {
    vi.useFakeTimers();
    const hub = broadcastHub();
    configureHost(createTestHost({ broadcast: hub.open, locks: undefined }));
    const reload = vi.fn();
    const stop = onBrowserReset(reload);

    hub.open().postMessage({ kind: "reset", tab: "other", phase: "start" });
    // Longer than any bounded reset: the old fixed 15 s wait was not.
    vi.advanceTimersByTime(119_000);
    expect(reload).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_000);
    expect(reload).toHaveBeenCalledTimes(1);
    stop();
  });
});

/** A Web Lock another tab holds until the test releases it. */
function heldLock() {
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const asked: string[] = [];
  const port: LockManagerLike = overlapCast({
    request: async (name: string, granted: () => void) => {
      asked.push(name);
      await held;
      return granted();
    },
  });
  return { port, asked, release: () => release() };
}
