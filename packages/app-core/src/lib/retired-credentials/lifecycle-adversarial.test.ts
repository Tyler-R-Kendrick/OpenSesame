import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { kvGet, kvSet } from "../kv.js";
import {
  assertNotRetiredCredentialAcrossVaults,
  probeRetiredCredential,
  recordRetiredDecoyInteraction,
  refreshRetiredCredentialStatus,
  retiredCredentialStorageSeams,
  withRetiredCredentialChange,
  withRetiredCredentialDuressArm,
  withRetiredCredentialDuressSeal,
} from "./index.js";
import { TRAPS_KEY, createRetiredCredentialFixture } from "./test-support.js";

let fixture: Awaited<ReturnType<typeof createRetiredCredentialFixture>>;
beforeEach(async () => {
  fixture = await createRetiredCredentialFixture();
});
afterEach(() => fixture.restore());

it("refuses a direct duress seal or global credential reuse before invoking its authority callback", async () => {
  await fixture.enroll("selected retired code");
  const commit = vi.fn(async () => "production authority");
  await expect(
    withRetiredCredentialDuressSeal("selected retired code", commit),
  ).rejects.toThrow(/collides/);
  await expect(
    assertNotRetiredCredentialAcrossVaults("selected retired code"),
  ).rejects.toThrow(/Remove/);
  await expect(
    withRetiredCredentialChange("selected retired code", "personal", commit),
  ).rejects.toThrow(/Remove/);
  expect(commit).not.toHaveBeenCalled();
});

it("binds delayed duress arming to trap authority but permits telemetry-only updates", async () => {
  await fixture.enroll("selected retired code", "synthetic_decoy");
  const draft = await withRetiredCredentialDuressSeal(
    "new duress code",
    async () => {
      await fixture.locks.request(
        "opensesame.retired-credentials",
        { ifAvailable: true },
        async (lock) => expect(lock).toBeNull(),
      );
      return "sealed draft";
    },
  );
  const disk = JSON.parse(kvGet(TRAPS_KEY) ?? "{}");
  await recordRetiredDecoyInteraction(
    "personal",
    disk.traps[0].id,
    "authority_denied",
  );
  const commit = vi.fn(async () => "armed");
  await expect(
    withRetiredCredentialDuressArm(draft.fingerprint, commit),
  ).resolves.toBe("armed");
  expect(commit).toHaveBeenCalledTimes(1);
  const changed = JSON.parse(kvGet(TRAPS_KEY) ?? "{}");
  changed.traps[0].response = "reject";
  kvSet(TRAPS_KEY, JSON.stringify(changed));
  await expect(
    withRetiredCredentialDuressArm(draft.fingerprint, commit),
  ).rejects.toThrow(/Seal this duress code again/);
  expect(commit).toHaveBeenCalledTimes(1);
});

it("refuses a competing cross-tab lock and recovers only after the competing operation releases it", async () => {
  await fixture.enroll("selected retired code");
  await fixture.locks.request(
    "opensesame.retired-credentials",
    { mode: "exclusive" },
    async () => {
      await expect(
        probeRetiredCredential("selected retired code", "personal"),
      ).rejects.toThrow(/already running/);
    },
  );
  expect(
    await probeRetiredCredential("selected retired code", "personal"),
  ).toMatchObject({ response: "reject" });
});

it("keeps an unenrolled vault usable without cross-tab locks but refuses a selected trap without them", async () => {
  retiredCredentialStorageSeams.locks = () => undefined;
  expect(await probeRetiredCredential("stale autofill", "personal")).toBeNull();
  await expect(
    assertNotRetiredCredentialAcrossVaults("new duress code"),
  ).resolves.toBeUndefined();
  const draft = await withRetiredCredentialDuressSeal(
    "new duress code",
    async () => "legacy draft",
  );
  await expect(
    withRetiredCredentialDuressArm(draft.fingerprint, async () => "arm"),
  ).resolves.toBe("arm");
  expect(await refreshRetiredCredentialStatus("personal")).toMatchObject({
    traps: [],
    events: [],
  });
  await expect(
    withRetiredCredentialChange(
      "new owner password",
      "personal",
      async () => "commit",
    ),
  ).resolves.toBe("commit");
  retiredCredentialStorageSeams.locks = () => fixture.locks;
  await fixture.enroll("selected retired code");
  const before = kvGet(TRAPS_KEY);
  retiredCredentialStorageSeams.locks = () => undefined;
  await expect(
    probeRetiredCredential("selected retired code", "personal"),
  ).rejects.toThrow(/locking is required/);
  expect(kvGet(TRAPS_KEY)).toBe(before);
});
