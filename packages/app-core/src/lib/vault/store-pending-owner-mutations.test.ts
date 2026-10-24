/** A primary-only pending unlock cannot remove its remaining configured factors. */
import { expect, test } from "vitest";
import {
  OWNER_PASSWORD,
  retiredOwnerFixture,
} from "./retired-owner.fixture.js";
test("pending second step cannot mutate primary credentials or disable configured factors", async () => {
  const f = await retiredOwnerFixture(true);
  try {
    await f.store.unlock(OWNER_PASSWORD);
    expect(f.store.getSnapshot().awaitingSecondStep).toBe(true);
    expect(f.store.isGenuineSession()).toBe(false);
    const before = f.store.getSnapshot();
    for (const mutate of [
      () => f.store.removeTotp(),
      () => f.store.removePassword(),
      () => f.store.removePin(),
      () => f.store.removeCode("email"),
      () =>
        f.store.changeMasterPassword(
          OWNER_PASSWORD,
          "new primary without completing factor 49275",
        ),
    ])
      await expect(mutate()).rejects.toThrow("Unlock the vault");
    expect(f.store.getSnapshot()).toEqual(before);
    expect(f.store.getSnapshot().awaitingSecondStep).toBe(true);
    expect(f.store.isGenuineSession()).toBe(false);
  } finally {
    f.dispose();
  }
});
