/** @vitest-environment node */
import { DEVICE_CONNECTOR_KEYS } from "@opensesame/app-core/lib/device-connector-records.js";
import {
  kvFlush,
  kvForgetAll,
  kvHydrate,
} from "@opensesame/app-core/lib/kv.js";
import { runtimeFixture } from "@opensesame/app-core/lib/secret-backends/runtime.test-support.js";
import {
  configureBrowserNodeState,
  savedBrowserNodeConfiguration,
} from "@opensesame/app-core/lib/tailscale/browser-node-store.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { expect, it } from "vitest";
import { identityNodeFixture } from "./identity-node.test-support.js";

it("cold hydration selects the saved public route while the vault remains locked and the new identity Worker generates only memory state", async () => {
  // Factory/owner capture precedes the first storage/private operation.
  const f = await identityNodeFixture();
  const storage = await runtimeFixture();
  const check = () => {
    if (vaultStore.getSnapshot().status !== "unlocked")
      throw new Error("Original vault locked");
  };
  try {
    await configureBrowserNodeState(
      { ...f.configuration, hostname: "saved-public-route" },
      vaultStore.getSnapshot().tomb,
      check,
    );
    await kvFlush();
    await vaultStore.lock();
    kvForgetAll();
    expect(savedBrowserNodeConfiguration()).toBeNull();
    await kvHydrate([...DEVICE_CONNECTOR_KEYS]);
    const saved = savedBrowserNodeConfiguration();
    expect(saved).toEqual({
      ...f.configuration,
      hostname: "saved-public-route",
    });
    if (!saved?.nativeHTTP)
      throw new Error("Original saved route failed to hydrate.");
    expect(saved).not.toHaveProperty("authKey");
    expect(saved).not.toHaveProperty("state");
    const before = vaultStore.getSnapshot();
    await f.connect({
      controlURL: saved.controlURL,
      nativeHTTP: saved.nativeHTTP,
    });
    expect(f.node.snapshot().hostname).not.toBe(saved.hostname);
    expect(vaultStore.getSnapshot()).toBe(before);
    expect(before.status).toBe("locked");
    expect(JSON.stringify([...storage.files.values()])).not.toContain(
      "worker-private-generated-state",
    );
    expect(await f.node.stop()).toBe(true);
    await f.thread.exit;
    expect(f.browserFetch).not.toHaveBeenCalled();
  } finally {
    await f.node.stop();
    await storage.close();
  }
});

it("the actual Networking runtime mounts the lazy original factory and releases it on lease withdrawal", async () => {
  const { vi } = await import("vitest");
  const { captureIdentityBrowserNode } = await import(
    "@opensesame/app-core/lib/tailscale/browser-node-identity-port.js"
  );
  const { statusFixture } = await import("./authorization.test-support.js");
  vi.stubGlobal("location", { origin: "https://pwa.example.test" });
  const f = await statusFixture();
  const signal = new AbortController().signal;
  const owner = { signal, assertCurrent: () => signal.throwIfAborted() };
  try {
    const original = captureIdentityBrowserNode(owner);
    if (!original)
      throw new Error(
        "Actual Networking runtime did not mount the identity factory.",
      );
    expect(original.snapshot().status).toBe("stopped");
    expect(f.fetcher).not.toHaveBeenCalled();
    f.revoke();
    expect(() => original.snapshot()).toThrow();
    expect(captureIdentityBrowserNode(owner)).toBeNull();
    expect(await original.stop()).toBe(true);
    expect(f.fetcher).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});
