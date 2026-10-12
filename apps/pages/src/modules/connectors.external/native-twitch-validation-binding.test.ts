// @vitest-environment jsdom
import { bindNativeProviderTransport } from "@opensesame/app-core/lib/native-connector-transport.js";
import {
  saveValidationFixture,
  validationBackend,
  validationTransport,
} from "@opensesame/app-core/lib/native-twitch-session-validation.test-support.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { afterEach, expect, it, vi } from "vitest";
import { createActivation } from "../activation.js";
import { createTestContext } from "../test-context.js";
import { bindNativeTwitchValidation } from "./native-twitch-validation.js";

const releases: (() => void)[] = [];
afterEach(() => {
  for (const release of releases.splice(0).reverse()) release();
  vaultStore.lock();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
it("binds real vault unlock/lock subscriptions and the capability activation lifetime", async () => {
  validationBackend();
  vaultStore.lock();
  await vaultStore.createGuest();
  expect(vaultStore.isUnlocked()).toBe(true);
  await saveValidationFixture();
  const provider = validationTransport();
  releases.push(bindNativeProviderTransport(provider.transport));
  const test = createTestContext();
  const activation = createActivation(test.ctx, "connectors.external");
  releases.push(activation.dispose);
  vi.useFakeTimers();
  bindNativeTwitchValidation(activation);
  await vi.advanceTimersByTimeAsync(0);
  expect(provider.fetcher).toHaveBeenCalledOnce();
  vaultStore.lock();
  expect(vaultStore.isUnlocked()).toBe(false);
  await vi.advanceTimersByTimeAsync(60 * 60_000);
  expect(provider.fetcher).toHaveBeenCalledOnce();
  test.abort("capability disabled");
  expect(activation.disposed()).toBe(true);
  window.dispatchEvent(new Event("focus"));
  document.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(60 * 60_000);
  expect(provider.fetcher).toHaveBeenCalledOnce();
});
