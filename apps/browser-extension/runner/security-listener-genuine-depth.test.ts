// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { configureHost } from "@opensesame/app-core/host.js";
import { kvFlush } from "@opensesame/app-core/lib/kv.js";
import { enrollRetiredCredential } from "@opensesame/app-core/lib/retired-credentials/index.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { PERSONAL_TOMB } from "@opensesame/app-core/lib/vfs.js";
import { createTestHost } from "@opensesame/app-core/test-host.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  ORIGIN,
  closeGenuineRunnerFixtures,
  genuineRunnerPermit,
} from "./test-support/genuine-runner-permit.fixture";

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

it.each(["disconnect", "expiry"])(
  "withholds actual encrypted status after %s without accepting a successor lease",
  async (kind) => {
    const f = await genuineRunnerPermit();
    const hold = f.raw.holdNext("keys");
    const pending = f.request("opensesame.runner.status", f.initial.permit);
    try {
      await hold.started;
      if (kind === "disconnect") f.port.close();
      else f.clock.now += 300_000;
    } finally {
      hold.release();
    }
    expect(await pending).toEqual({ error: "vault_locked" });
    expect(f.connections).toBe(0);
    if (kind === "expiry") {
      const current = await f.unlock();
      expect(current.realm).toBe("real");
      expect(current.permit).not.toBe(f.initial.permit);
      expect(
        await f.request("opensesame.runner.status", current.permit),
      ).toMatchObject({ credentials: [ORIGIN], lastPass: null });
      expect(
        await f.request("opensesame.runner.status", f.initial.permit),
      ).toEqual({ error: "vault_locked" });
    }
    f.close();
  },
);

it("rolls back a physically stored real AES arm after same-owner replacement and starts no tick", async () => {
  const f = await genuineRunnerPermit();
  const hold = f.raw.holdNext("arm");
  const pending = f.request("opensesame.runner.arm", f.initial.permit);
  try {
    await hold.started;
    expect([...f.raw.rows.values()].join(" ")).not.toContain(ORIGIN);
    const current = await f.unlock();
    expect(current.realm).toBe("real");
    expect(current.permit).not.toBe(f.initial.permit);
  } finally {
    hold.release();
  }
  expect(await pending).toEqual({ error: "vault_locked" });
  expect(await f.settings.isArmed(ORIGIN)).toBe(false);
  expect(f.revoked).toEqual([ORIGIN]);
  expect(f.granted.has(ORIGIN)).toBe(false);
  expect(f.connections).toBe(0);
  const current = await f.unlock();
  expect((await f.runner.status(current.permit)).lastPass).toBeNull();
  f.close();
});

it("classifies an actually enrolled retired password and denies runner reads before physical storage", async () => {
  const f = await genuineRunnerPermit();
  const retired = "public-retired-runner-fixture";
  await vaultStore.unlock(f.owner.password);
  await enrollRetiredCredential({
    tomb: PERSONAL_TOMB,
    currentPassword: f.owner.password,
    retiredPassword: retired,
    response: "synthetic_decoy",
    acknowledgePasswordVerifierRisk: true,
  });
  vaultStore.lock();
  const synthetic = await f.unlock(retired);
  expect(synthetic.realm).toBe("synthetic");
  const before = f.raw.reads;
  for (const type of [
    "opensesame.runner.status",
    "opensesame.runner.arm",
    "opensesame.runner.disarm",
  ])
    expect(await f.request(type, synthetic.permit)).toEqual({
      error: "vault_locked",
    });
  expect(f.raw.reads).toBe(before);
  expect(f.connections).toBe(0);
  const current = await f.unlock();
  expect(current.realm).toBe("real");
  expect(current.permit).not.toBe(f.initial.permit);
  expect(await f.request("opensesame.runner.status", f.initial.permit)).toEqual(
    { error: "vault_locked" },
  );
  const reply = await f.request("opensesame.runner.status", current.permit);
  expect(reply).toMatchObject({ credentials: [ORIGIN], session: false });
  expect(JSON.stringify(reply)).not.toContain("public-runner-value");
  f.close();
});
