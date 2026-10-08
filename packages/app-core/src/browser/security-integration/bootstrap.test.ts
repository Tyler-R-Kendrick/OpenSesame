// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { configureHost } from "../../host.js";
import { kvFlush } from "../../lib/kv.js";
import { vaultStore } from "../../lib/vault/store.js";
import { createTestHost } from "../../test-host.js";
import { startSecurityPanel } from "../security/bootstrap.js";
import {
  persistentBrowserOwner,
  persistentManagementBridge,
} from "./management-host.fixture.js";

it("exposes no permit or production authority until the actual owner unlocks the mounted panel", async () => {
  const owner = await persistentBrowserOwner();
  const bridge = persistentManagementBridge();
  const root = document.createElement("section");
  const changes: boolean[] = [];
  let release = () => {};
  const resumed = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started = () => {};
  const held = new Promise<void>((resolve) => {
    started = resolve;
  });
  const work: Promise<void>[] = [];
  let observer: MutationObserver | undefined;
  let actionCompletion: Promise<void> | undefined;
  try {
    const security = startSecurityPanel(root, bridge.runtime, (allowed) =>
      changes.push(allowed),
    );
    expect(changes).toEqual([false]);
    expect(security.permit()).toBeUndefined();
    await expect(security.requireProduction()).rejects.toThrow();
    await security.ready;
    expect(security.permit()).toBeUndefined();
    const password = root.querySelector('input[type="password"]');
    const unlock = root.querySelector("button");
    if (!(password instanceof HTMLInputElement) || !unlock)
      throw new Error("Missing actual unlock controls");
    password.value = owner.password;
    if (!(unlock instanceof HTMLButtonElement))
      throw new Error("Missing actual unlock button");
    const originalUnlock = vaultStore.unlock.bind(vaultStore);
    vi.spyOn(vaultStore, "unlock").mockImplementation((submitted) => {
      const actual = (async () => {
        await originalUnlock(submitted);
        started();
        await resumed;
      })();
      work.push(actual);
      return actual;
    });
    actionCompletion = new Promise<void>((resolve) => {
      observer = new MutationObserver(() => {
        if (!unlock.disabled) resolve();
      });
      observer.observe(unlock, {
        attributes: true,
        attributeFilter: ["disabled"],
      });
    });
    unlock.click();
    expect(unlock.disabled).toBe(true);
    await held;
    expect(security.permit()).toBeDefined();
    expect(changes.at(-1)).toBe(false);
    await expect(security.requireProduction()).rejects.toThrow(
      "Unlock the real vault to use connected services.",
    );
    release();
    await actionCompletion;
    expect(unlock.disabled).toBe(false);
    expect(security.permit()).toBeDefined();
    await expect(security.requireProduction()).resolves.toBeUndefined();
    expect(changes.at(-1)).toBe(true);
    vaultStore.lock();
    await expect(security.requireProduction()).rejects.toThrow();
  } finally {
    release();
    try {
      await Promise.allSettled(work);
      await actionCompletion;
    } finally {
      observer?.disconnect();
      bridge.close();
      await bridge.drain();
      vaultStore.lock();
      await kvFlush();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      configureHost(createTestHost());
    }
  }
});
