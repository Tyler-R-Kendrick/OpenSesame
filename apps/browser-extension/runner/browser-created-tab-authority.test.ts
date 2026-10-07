// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { configureHost } from "@opensesame/app-core/host.js";
import { kvFlush } from "@opensesame/app-core/lib/kv.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { createTestHost } from "@opensesame/app-core/test-host.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { browserPages } from "./browser";
import { FakeBrowser } from "./test-support/fake-browser";
import {
  ORIGIN,
  closeGenuineRunnerFixtures,
  genuineRunnerPermit,
} from "./test-support/genuine-runner-permit.fixture";
import { physicalHold } from "./test-support/runner-authority-lifecycle.fixture";
import { Site } from "./test-support/site";
import { RunnerAuthorityEnded, runnerOwner } from "./worker-authority";

beforeEach(() => {
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("CryptoKey", webcrypto.CryptoKey);
});
afterEach(async () => {
  closeGenuineRunnerFixtures();
  vaultStore.lock();
  await kvFlush();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  configureHost(createTestHost());
});

it("retires only its created tab when the subsequent real encrypted markActive return is revoked", async () => {
  const f = await genuineRunnerPermit();
  const fake = new FakeBrowser(new Site("public-fixture-value"));
  fake.install();
  const hold = physicalHold();
  const actualSet = f.raw.set.bind(f.raw);
  vi.spyOn(f.raw, "set").mockImplementation(async (key, value) => {
    await actualSet(key, value);
    if (key === "runner.active") await hold.pause();
  });
  const owner = runnerOwner(f.broker, f.initial.permit, ORIGIN, () => true);
  const opening = browserPages(f.settings)(
    { id: "public-created-tab", origin: ORIGIN },
    owner,
  );
  const rejection =
    expect(opening).rejects.toBeInstanceOf(RunnerAuthorityEnded);
  try {
    await hold.started;
    expect(fake.tabs.size).toBe(1);
    const original = [...fake.tabs.keys()][0];
    f.port.close();
    const successor = await browser.tabs.create({
      url: "about:blank",
      active: false,
    });
    expect(successor.id).not.toBe(original);
    hold.release();
    await rejection;
    expect(fake.tabs.has(original ?? -1)).toBe(false);
    expect(fake.tabs.has(successor.id ?? -1)).toBe(true);
    expect(fake.injected).toEqual([]);
  } finally {
    hold.release();
    await opening.catch(() => undefined);
    f.close();
  }
});
