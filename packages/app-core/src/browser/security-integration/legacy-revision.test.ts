import { afterEach, expect, it, vi } from "vitest";
import { configureHost } from "../../host.js";
import { kvFlush } from "../../lib/kv.js";
import { vaultStore } from "../../lib/vault/store.js";
import { createTestHost } from "../../test-host.js";
import {
  persistentBrowserOwner,
  persistentManagementBridge,
} from "./management-host.fixture.js";
let bridge: ReturnType<typeof persistentManagementBridge> | undefined;
afterEach(async () => {
  bridge?.close();
  await bridge?.drain();
  vaultStore.lock();
  await kvFlush();
  vi.unstubAllGlobals();
  configureHost(createTestHost());
});
it.each(["password", "policy"] as const)(
  "rejects the original extension permit after genuine owner %s changes",
  async (change) => {
    const owner = await persistentBrowserOwner();
    bridge = persistentManagementBridge();
    await expect(bridge.client.unlock(owner.password)).resolves.toMatchObject({
      realm: "real",
    });
    await vaultStore.unlock(owner.password);
    const next = change === "password" ? crypto.randomUUID() : owner.password;
    await vaultStore.changeMasterPassword(
      owner.password,
      next,
      "Updated owner policy",
    );
    await kvFlush();
    expect(await bridge.client.authorize()).toBe(false);
    await expect(
      bridge.client.manage({ verb: "legacy-status" }, next),
    ).rejects.toThrow("Owner management failed");
    const { verifyCurrentCredential } = await import(
      "../../lib/retired-credentials/owner-auth.js"
    );
    await verifyCurrentCredential("personal", next);
    bridge.close();
    await bridge.drain();
    bridge = persistentManagementBridge();
    expect(await bridge.client.unlock(next)).toMatchObject({ realm: "real" });
    await expect(
      bridge.client.manage({ verb: "legacy-status" }, next),
    ).resolves.toBe(
      JSON.stringify({ pending: false, available: true, records: [] }),
    );
  },
);
