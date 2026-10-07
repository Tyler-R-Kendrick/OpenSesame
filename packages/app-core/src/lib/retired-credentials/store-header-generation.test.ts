import * as vaultCore from "@opensesame/vault-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearVaultSurface } from "../vault/protection/protector-enrollment.test-support.js";
import * as methods from "../vault/unlock-methods.js";
import { retiredCredentialStatus } from "./index.js";
import { openRetiredCredentialDecoy } from "./session.js";
import { createRetiredCredentialFixture } from "./test-support.js";
import { unlockWithRetiredCredentialGate } from "./unlock.js";
function deferred() {
  let finish = () => {};
  const promise = new Promise<void>((resolve) => {
    finish = resolve;
  });
  return { promise, finish: () => finish() };
}
let fixture: Awaited<ReturnType<typeof createRetiredCredentialFixture>>;
beforeEach(async () => {
  fixture = await createRetiredCredentialFixture();
  await fixture.enroll("selected retired password", "synthetic_decoy");
});
afterEach(() => {
  vi.restoreAllMocks();
  fixture.restore();
});
it.each(["create", "enroll"] as const)(
  "rejects a stale PIN %s after actual cryptography before publishing its real header",
  async (mode) => {
    const reached = deferred();
    const blocked = deferred();
    const wrap = methods.wrapVaultKeyWithPin;
    vi.spyOn(methods, "wrapVaultKeyWithPin").mockImplementationOnce(
      async (...args) => {
        const actual = await wrap(...args);
        reached.finish();
        await blocked.promise;
        return actual;
      },
    );
    const pending = (
      mode === "create"
        ? fixture.store.createWithPin("93746281")
        : fixture.store.enrollPin("93746281")
    ).then(
      () => null,
      (error: Error) => error,
    );
    await reached.promise;
    fixture.store.lock();
    await unlockWithRetiredCredentialGate(
      fixture.store,
      "selected retired password",
    );
    const current = fixture.store.getSnapshot();
    blocked.finish();
    expect(await pending).toBeInstanceOf(Error);
    expect(fixture.store.getSnapshot()).toEqual(current);
    expect(current).toMatchObject({ decoy: true, guest: true });
  },
);
it("wipes a newly created real password root and withholds its header after direct synthetic admission", async () => {
  const trap = retiredCredentialStatus("personal").traps[0];
  if (!trap) throw new Error("Expected an actual enrolled trap");
  const reached = deferred();
  const blocked = deferred();
  const create = vaultCore.createVault;
  let raw: Uint8Array | null = null;
  vi.spyOn(vaultCore, "createVault").mockImplementationOnce(async (...args) => {
    const actual = await create(...args);
    raw = actual.rawVaultKey;
    reached.finish();
    await blocked.promise;
    return actual;
  });
  const pending = fixture.store.create("a new production password").then(
    () => null,
    (error: Error) => error,
  );
  await reached.promise;
  fixture.store.lock();
  // Password creation owns the trap lifecycle lock; a direct constructor is a stronger hostile caller.
  await openRetiredCredentialDecoy(fixture.store, trap, "personal");
  const current = fixture.store.getSnapshot();
  blocked.finish();
  expect(await pending).toBeInstanceOf(Error);
  expect(fixture.store.getSnapshot()).toEqual(current);
  if (!raw) throw new Error("Expected an actual newly generated root");
  expect(Array.from(raw)).toEqual(Array.from({ length: 32 }, () => 0));
});

it("cancels an earlier same-scope PIN creation when a newer password creation finishes first", async () => {
  fixture.store.lock();
  await clearVaultSurface();
  const reached = deferred();
  const blocked = deferred();
  const wrap = methods.wrapVaultKeyWithPin;
  vi.spyOn(methods, "wrapVaultKeyWithPin").mockImplementationOnce(
    async (...args) => {
      const actual = await wrap(...args);
      reached.finish();
      await blocked.promise;
      return actual;
    },
  );
  const stale = fixture.store.createWithPin("93746281").then(
    () => null,
    (error: Error) => error,
  );
  await reached.promise;
  await fixture.store.create("new current owner password");
  const current = fixture.store.getSnapshot();
  blocked.finish();
  expect(await stale).toBeInstanceOf(Error);
  expect(fixture.store.getSnapshot()).toEqual(current);
  fixture.store.lock();
  await fixture.store.unlock("new current owner password");
  expect(fixture.store.getSnapshot().status).toBe("unlocked");
});
