import { afterEach, expect, it, vi } from "vitest";
import { genuineRecord } from "../__tests__/device-identity-records.js";
import { webLocksDouble } from "../__tests__/web-locks-double.js";
import * as identityKeys from "../device-identity-key.js";
import { bodyPortOf } from "../vault/store-device-key.js";
import { PASSWORD, createRetiredCredentialFixture } from "./test-support.js";
import { unlockWithRetiredCredentialGate } from "./unlock.js";

function deferred() {
  let finish = () => {};
  const promise = new Promise<void>((resolve) => {
    finish = resolve;
  });
  return { promise, finish: () => finish() };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("never carries a real device signing key into a successor synthetic realm", async () => {
  const fixture = await createRetiredCredentialFixture();
  vi.stubGlobal("navigator", { locks: webLocksDouble() });
  try {
    await fixture.enroll("selected retired password", "synthetic_decoy");
    const realKey = await genuineRecord(Date.now());
    await identityKeys.writeStoredDeviceIdentityKey("personal", realKey);
    fixture.store.lock();
    const reached = deferred();
    const blocked = deferred();
    const read = identityKeys.readStoredDeviceIdentityKey;
    vi.spyOn(
      identityKeys,
      "readStoredDeviceIdentityKey",
    ).mockImplementationOnce(async (tomb) => {
      const key = await read(tomb);
      expect(key?.keyId).toBe(realKey.keyId);
      reached.finish();
      await blocked.promise;
      return key;
    });
    const pending = fixture.store.unlock(PASSWORD).then(
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
    expect(
      bodyPortOf(fixture.store).body().deviceIdentityKey === undefined,
    ).toBe(true);
    expect(fixture.store.getSnapshot()).toEqual(current);
  } finally {
    fixture.restore();
  }
});
