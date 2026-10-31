import { expect, it, vi } from "vitest";
import * as deadman from "../deadman/state.js";
import * as selfAuth from "./self-authenticator.js";
import { enrollTotp } from "./store-totp.fixture.js";
import {
  deferred,
  installUnlockRacesFixture,
  pendingLegacyTotp,
} from "./store-unlock-races.fixture.js";

installUnlockRacesFixture();

it.each(["removed", "replaced"] as const)(
  "late legacy registration preserves a %s verified factor",
  async (change) => {
    const { store, code } = await pendingLegacyTotp();
    const started = deferred();
    const gate = deferred();
    const record = deadman.recordDeadmanAuthentication;
    vi.spyOn(deadman, "recordDeadmanAuthentication").mockImplementationOnce(
      async (...args) => {
        await record(...args);
        started.release();
        await gate.promise;
      },
    );
    const confirm = store.confirmTotp(await code());
    await started.promise;
    try {
      await store.removeTotp();
      if (change === "replaced") await enrollTotp(store);
      const current = store.getSnapshot().header?.unlocks?.totp;
      if (change === "removed") expect(current).toBeUndefined();
      else expect(current?.selfItemId).toBeTruthy();
      const items = store.getSnapshot().items;
      gate.release();
      await confirm;
      expect(store.isUnlocked()).toBe(true);
      expect(store.getSnapshot().header?.unlocks?.totp).toEqual(current);
      expect(store.getSnapshot().items).toEqual(items);
    } finally {
      gate.release();
      await confirm;
    }
  },
);

it("removing a gate during registration prevents its item and header publication", async () => {
  const { store, code } = await pendingLegacyTotp();
  const started = deferred();
  const gate = deferred();
  const register = selfAuth.withSelfAuthenticatorRegistration;
  vi.spyOn(
    selfAuth,
    "withSelfAuthenticatorRegistration",
  ).mockImplementationOnce(async (...args) => {
    const next = await register(...args);
    started.release();
    await gate.promise;
    return next;
  });
  const refused = expect(store.confirmTotp(await code())).rejects.toMatchObject(
    { code: "stale_operation" },
  );
  await started.promise;
  try {
    await store.removeTotp();
    const items = store.getSnapshot().items;
    gate.release();
    await refused;
    expect(store.isUnlocked()).toBe(true);
    expect(store.getSnapshot().header?.unlocks?.totp).toBeUndefined();
    expect(store.getSnapshot().items).toEqual(items);
  } finally {
    gate.release();
    await refused;
  }
});
