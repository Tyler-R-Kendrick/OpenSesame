import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { markDecoySession } from "../decoy-session.js";
import { clearActivePresentation } from "../duress/compartment/presentation-runtime.js";
import { kvSet } from "../kv.js";
import { retiredCredentialStorageSeams } from "./index.js";
import {
  PASSWORD,
  TRAPS_KEY,
  createRetiredCredentialFixture,
} from "./test-support.js";
import { unlockWithRetiredCredentialGate } from "./unlock.js";

let fixture: Awaited<ReturnType<typeof createRetiredCredentialFixture>>;
beforeEach(async () => {
  fixture = await createRetiredCredentialFixture();
});
afterEach(() => {
  vi.restoreAllMocks();
  clearActivePresentation();
  fixture.restore();
});

it("preserves current-password admission through the portable core gate", async () => {
  fixture.store.lock();
  await expect(
    unlockWithRetiredCredentialGate(fixture.store, PASSWORD),
  ).resolves.toBe("vault_opened");
  expect(fixture.store.getSnapshot().status).toBe("unlocked");
  expect(fixture.store.getSnapshot().guest).toBe(false);
});

it.each(["reject", "synthetic_decoy"] as const)(
  "routes a selected %s trap through core without calling production unwrap",
  async (response) => {
    await fixture.enroll("selected retired password", response);
    fixture.store.lock();
    const productionUnlock = vi.spyOn(fixture.store, "unlock");
    const attempt = unlockWithRetiredCredentialGate(
      fixture.store,
      "selected retired password",
    );
    if (response === "reject") {
      await expect(attempt).rejects.toThrow();
      expect(fixture.store.getSnapshot().status).toBe("locked");
    } else {
      await expect(attempt).resolves.toBe("retired_credential_session");
      expect(fixture.store.getSnapshot()).toMatchObject({
        status: "unlocked",
        decoy: true,
        guest: true,
      });
    }
    expect(productionUnlock).not.toHaveBeenCalled();
  },
);

it("refuses corrupt detector state through the direct core API", async () => {
  await fixture.enroll("selected retired password");
  fixture.store.lock();
  kvSet(TRAPS_KEY, "corrupt detector");
  const productionUnlock = vi.spyOn(fixture.store, "unlock");
  await expect(
    unlockWithRetiredCredentialGate(fixture.store, PASSWORD),
  ).rejects.toThrow();
  expect(productionUnlock).not.toHaveBeenCalled();
  expect(fixture.store.getSnapshot().status).toBe("locked");
});

it("refuses a vault-scope change before admitting any descendant realm", async () => {
  await fixture.enroll("selected retired password", "synthetic_decoy");
  fixture.store.lock();
  vi.spyOn(fixture.store, "activeTomb")
    .mockReturnValueOnce("personal")
    .mockReturnValue("another-vault");
  const productionUnlock = vi.spyOn(fixture.store, "unlock");
  const syntheticUnlock = vi.spyOn(fixture.store, "createGuest");
  await expect(
    unlockWithRetiredCredentialGate(fixture.store, "selected retired password"),
  ).rejects.toThrow();
  expect(productionUnlock).not.toHaveBeenCalled();
  expect(syntheticUnlock).not.toHaveBeenCalled();
});

it.each([
  ["current", "lock"],
  ["retired", "lock"],
  ["current", "round_trip"],
  ["retired", "round_trip"],
])(
  "withholds a late %s admission across a same-vault %s",
  async (credential, transition) => {
    await fixture.enroll("selected retired password", "synthetic_decoy");
    fixture.store.lock();
    retiredCredentialStorageSeams.refresh = async () => {
      if (transition === "round_trip") markDecoySession(true);
      markDecoySession(false);
    };
    const productionUnlock = vi.spyOn(fixture.store, "unlock");
    const syntheticUnlock = vi.spyOn(fixture.store, "createGuest");
    await expect(
      unlockWithRetiredCredentialGate(
        fixture.store,
        credential === "current" ? PASSWORD : "selected retired password",
      ),
    ).rejects.toThrow(/authenticate again/);
    expect(productionUnlock).not.toHaveBeenCalled();
    expect(syntheticUnlock).not.toHaveBeenCalled();
    expect(fixture.store.getSnapshot().status).toBe("locked");
  },
);
