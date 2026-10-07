import { afterEach, beforeEach, expect, it } from "vitest";
import { isRealAuthorityBlocked } from "../decoy-session.js";
import { kvGet, kvSet } from "../kv.js";
import { HEADER_KEY } from "../vault/protection/protector-enrollment.test-support.js";
import {
  probeRetiredCredential,
  withRetiredCredentialChange,
} from "./index.js";
import {
  authenticateRetiredCredentialOwner,
  retiredCredentialEnrollmentSupported,
  verifyCurrentCredential,
} from "./owner-auth.js";
import { PASSWORD, createRetiredCredentialFixture } from "./test-support.js";
import { unlockWithRetiredCredentialGate } from "./unlock.js";
let fixture: Awaited<ReturnType<typeof createRetiredCredentialFixture>>;
beforeEach(async () => {
  fixture = await createRetiredCredentialFixture();
});
afterEach(() => fixture.restore());
it("enrolls and detects through a normal real VaultStore projected manifest without releasing its session", async () => {
  expect(fixture.store.getSnapshot().header?.protection?.records[0]?.kind).toBe(
    "password",
  );
  expect(retiredCredentialEnrollmentSupported("personal")).toBe(true);
  await fixture.enroll("retired password");
  fixture.store.lock();
  expect(
    (await probeRetiredCredential("retired password", "personal"))?.response,
  ).toBe("reject");
  expect(fixture.store.getSnapshot().status).toBe("locked");
});
it("uses the authoritative current protector and ignores an obsolete top-level password wrap", async () => {
  const header = JSON.parse(kvGet(HEADER_KEY) ?? "{}");
  header.kdf = undefined;
  header.wrap = undefined;
  kvSet(HEADER_KEY, JSON.stringify(header));
  await expect(
    authenticateRetiredCredentialOwner("personal", PASSWORD, async () => {}),
  ).resolves.toBeUndefined();
});
it("refuses tampered authenticated manifest and revoked password protector despite top-level wrap", async () => {
  const header = JSON.parse(kvGet(HEADER_KEY) ?? "{}");
  header.protection.revision += 1;
  kvSet(HEADER_KEY, JSON.stringify(header));
  await expect(
    authenticateRetiredCredentialOwner("personal", PASSWORD, async () => {}),
  ).rejects.toThrow(/Manifest authentication/);
  header.protection.records = [];
  kvSet(HEADER_KEY, JSON.stringify(header));
  expect(retiredCredentialEnrollmentSupported("personal")).toBe(false);
  await expect(
    authenticateRetiredCredentialOwner("personal", PASSWORD, async () => {}),
  ).rejects.toThrow();
});
it("holds the cross-tab lock through the mutation callback", async () => {
  await withRetiredCredentialChange("new password", "personal", async () => {
    await fixture.locks.request(
      "opensesame.retired-credentials",
      { ifAvailable: true },
      async (lock) => {
        expect(lock).toBeNull();
      },
    );
  });
  expect(fixture.locks.peak()).toBe(1);
});

it("proves only current password admission while a real owner session is locked and refuses required MFA", async () => {
  fixture.store.lock();
  await expect(
    verifyCurrentCredential("personal", PASSWORD, async () => {}),
  ).resolves.toBeUndefined();
  expect(fixture.store.getSnapshot().status).toBe("locked");
  await expect(
    authenticateRetiredCredentialOwner("personal", PASSWORD, async () => {}),
  ).rejects.toThrow(/Unlock the real vault/);
  const header = JSON.parse(kvGet(HEADER_KEY) ?? "{}");
  header.unlocks = { ...header.unlocks, totp: { enabled: true } };
  kvSet(HEADER_KEY, JSON.stringify(header));
  await expect(
    verifyCurrentCredential("personal", PASSWORD, async () => {}),
  ).rejects.toThrow();
});

it("proves only the original current password during genuine pending recovery without admitting management", async () => {
  await fixture.enroll("selected recovery trap", "synthetic_decoy");
  fixture.store.lock();
  await unlockWithRetiredCredentialGate(
    fixture.store,
    "selected recovery trap",
  );
  fixture.store.lock();
  expect(isRealAuthorityBlocked()).toBe(true);
  await expect(
    verifyCurrentCredential("personal", "wrong password"),
  ).rejects.toThrow();
  await expect(
    verifyCurrentCredential("personal", PASSWORD),
  ).resolves.toBeUndefined();
  expect(isRealAuthorityBlocked()).toBe(true);
  await expect(
    authenticateRetiredCredentialOwner("personal", PASSWORD),
  ).rejects.toThrow();
  await unlockWithRetiredCredentialGate(fixture.store, PASSWORD);
  expect(isRealAuthorityBlocked()).toBe(false);
  await expect(
    authenticateRetiredCredentialOwner("personal", PASSWORD),
  ).resolves.toBeUndefined();
});
