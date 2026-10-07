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
    unlock.click();
    await vi.waitFor(async () => {
      expect(security.permit()).toBeDefined();
      await expect(security.requireProduction()).resolves.toBeUndefined();
    });
    expect(changes.at(-1)).toBe(true);
    vaultStore.lock();
    await expect(security.requireProduction()).rejects.toThrow();
  } finally {
    bridge.close();
    await bridge.drain();
    vaultStore.lock();
    await kvFlush();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    configureHost(createTestHost());
  }
});
