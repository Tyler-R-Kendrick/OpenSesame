/** @vitest-environment jsdom */
import { nativeProviderTransport } from "@opensesame/app-core/lib/native-connector-transport.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { afterEach, expect, it } from "vitest";
import { createActivation } from "../activation.js";
import { createTestContext } from "../test-context.js";
import { bindProviderRuntime } from "./native-runtime.js";
afterEach(() => vaultStore.lock());
it("gives each genuine session a new transport and never revives an old handle", async () => {
  const test = createTestContext();
  const activation = createActivation(test.ctx, "connectors.external");
  bindProviderRuntime(test.ctx, activation);
  try {
    expect(() => nativeProviderTransport()).toThrow();
    await vaultStore.create("controlled first native session password");
    const first = nativeProviderTransport();
    first.assertCurrent();
    vaultStore.lock();
    await vaultStore.createGuest();
    expect(() => nativeProviderTransport()).toThrow();
    expect(() => first.assertCurrent()).toThrow();
    vaultStore.lock();
    vaultStore.loadActiveProjectScope();
    await vaultStore.unlock("controlled first native session password");
    const second = nativeProviderTransport();
    expect(second).not.toBe(first);
    second.assertCurrent();
    expect(first.signal?.aborted).toBe(true);
    expect(() => first.assertCurrent()).toThrow();
  } finally {
    activation.dispose();
  }
});
