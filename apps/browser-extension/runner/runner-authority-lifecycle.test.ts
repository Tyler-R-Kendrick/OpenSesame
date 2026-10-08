// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { configureHost } from "@opensesame/app-core/host.js";
import { kvFlush } from "@opensesame/app-core/lib/kv.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { createTestHost } from "@opensesame/app-core/test-host.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  ORIGIN,
  closeGenuineRunnerFixtures,
} from "./test-support/genuine-runner-permit.fixture";
import {
  physicalHold,
  runnerAuthorityLifecycle,
} from "./test-support/runner-authority-lifecycle.fixture";

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
  document.body.replaceChildren();
});

it.each(["current", "disconnect"])(
  "physical claim-body return keeps the original authority: %s",
  async (change) => {
    const x = await runnerAuthorityLifecycle("claim");
    let tick: Promise<unknown> | undefined;
    try {
      await x.arm(x.f.initial.permit);
      await x.http.started;
      tick = x.runner.tick().catch((error: unknown) => error);
      const before = { ...x.page };
      expect(before).toEqual({ opened: 1, filled: 0 });
      if (change === "disconnect") x.f.port.close();
      x.http.release();
      await tick;
      x.http.assertTransport();
      if (change === "current") {
        expect(x.page.filled).toBe(1);
        expect(
          x.http.paths.filter((path) => path.endsWith("/steps/0/outcome")),
        ).toHaveLength(1);
        expect(
          document.querySelector<HTMLInputElement>("#held-runner-field")?.value,
        ).toBe("public-runner-value");
      } else {
        expect(x.page).toEqual(before);
        expect(x.http.paths.at(-1)).toMatch(/\/steps\/claim$/);
        expect(
          document.querySelector<HTMLInputElement>("#held-runner-field")?.value,
        ).toBe("");
      }
    } finally {
      x.http.release();
      await tick;
      await x.close();
    }
  },
);

it.each(["current", "disconnect"])(
  "physical AES-GCM plaintext return keeps the original authority: %s",
  async (change) => {
    const x = await runnerAuthorityLifecycle("none");
    const hold = physicalHold();
    let tick: Promise<unknown> | undefined;
    const actualDecrypt = crypto.subtle.decrypt.bind(crypto.subtle);
    let held = false;
    const decrypt = vi
      .spyOn(crypto.subtle, "decrypt")
      .mockImplementation(async (...args) => {
        const plaintext = await actualDecrypt(...args);
        const text = new TextDecoder().decode(plaintext);
        if (!held && text.includes('"password":"public-runner-value"')) {
          held = true;
          await hold.pause();
        }
        return plaintext;
      });
    try {
      await x.arm(x.f.initial.permit);
      await hold.started;
      tick = x.runner.tick().catch((error: unknown) => error);
      expect(held).toBe(true);
      expect(decrypt).toHaveBeenCalled();
      expect(x.page).toEqual({ opened: 0, filled: 0 });
      if (change === "disconnect") x.f.port.close();
      hold.release();
      await tick;
      x.http.assertTransport();
      if (change === "current") {
        expect(x.page).toEqual({ opened: 1, filled: 1 });
        expect(
          x.http.paths.filter((path) => path.endsWith("/steps/0/outcome")),
        ).toHaveLength(1);
      } else {
        expect(x.page).toEqual({ opened: 0, filled: 0 });
        expect(x.http.paths).toEqual(["/api/v1/agent/runs"]);
      }
    } finally {
      hold.release();
      await tick;
      decrypt.mockRestore();
      await x.close();
    }
  },
);

it("expired alarms and reconstructed workers cannot reuse disk consent; fresh explicit owner rearm can", async () => {
  const x = await runnerAuthorityLifecycle("none", false);
  try {
    await x.arm(x.f.initial.permit);
    await x.runner.tick();
    expect(x.http.paths).toEqual([]);
    expect(await x.f.settings.isArmed(ORIGIN)).toBe(true);
    await x.f.settings.setToken("public-runner-host-session");
    x.f.clock.now += 300_000;
    await x.runner.tick();
    expect(x.http.paths).toEqual([]);
    const restarted = x.restart();
    await restarted.tick();
    expect(x.http.paths).toEqual([]);
    const owner = await x.f.unlock();
    expect(owner.realm).toBe("real");
    await x.arm(owner.permit, restarted);
    await restarted.tick();
    x.http.assertTransport();
    expect(x.page).toEqual({ opened: 1, filled: 1 });
    expect(
      x.http.paths.filter((path) => path.endsWith("/steps/claim")),
    ).toHaveLength(1);
    expect(
      x.http.paths.filter((path) => path.endsWith("/steps/0/outcome")),
    ).toHaveLength(1);
  } finally {
    await x.close();
  }
});
