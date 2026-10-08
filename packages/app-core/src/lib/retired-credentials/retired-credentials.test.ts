import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { kvGet, kvSet } from "../kv.js";
import {
  assertNotRetiredCredential,
  clearRetiredCredentialEvents,
  enrollRetiredCredential,
  probeRetiredCredential,
  recordRetiredDecoyInteraction,
  refreshRetiredCredentialStatus,
  removeRetiredCredential,
  retiredCredentialStatus,
  retiredCredentialStorageSeams,
} from "./index.js";
import { parseRetiredCredentialRecords } from "./records.js";
import {
  PASSWORD,
  TRAPS_KEY,
  createRetiredCredentialFixture,
} from "./test-support.js";
let fixture: Awaited<ReturnType<typeof createRetiredCredentialFixture>>;
beforeEach(async () => {
  fixture = await createRetiredCredentialFixture();
});
afterEach(() => fixture.restore());
describe("retired credential traps", () => {
  it("requires owner authentication and explicit password-verifier risk consent", async () => {
    await expect(
      enrollRetiredCredential({
        tomb: "personal",
        currentPassword: "bad",
        retiredPassword: "old",
        acknowledgePasswordVerifierRisk: true,
      }),
    ).rejects.toThrow();
    await expect(
      enrollRetiredCredential({
        tomb: "personal",
        currentPassword: PASSWORD,
        retiredPassword: "old",
        acknowledgePasswordVerifierRisk: false,
      }),
    ).rejects.toThrow(/Acknowledge/);
    expect(kvGet(TRAPS_KEY)).toBeNull();
  });
  it("refuses locked owners", async () => {
    fixture.store.lock();
    await expect(fixture.enroll()).rejects.toThrow(/Unlock the real vault/);
    expect(kvGet(TRAPS_KEY)).toBeNull();
  });
  it("defaults to reject, scopes exactly, records bounded metadata without secrets", async () => {
    await fixture.enroll();
    expect(await probeRetiredCredential("retired-secret", "other")).toBeNull();
    expect(
      await probeRetiredCredential("retired-secret ", "personal"),
    ).toBeNull();
    expect(
      await probeRetiredCredential("retired-secret", "personal"),
    ).toMatchObject({ response: "reject" });
    expect(retiredCredentialStatus("personal").events).toHaveLength(1);
    const stored = kvGet(TRAPS_KEY);
    expect(stored).not.toContain("retired-secret");
    expect(stored).not.toContain(PASSWORD);
    expect(stored).toContain("retired_credential_observed");
  });
  it("does not normalize matches and rejects noncanonical enrollment or current-password collisions", async () => {
    await expect(fixture.enroll("K")).rejects.toThrow(/normalized/);
    await expect(fixture.enroll(PASSWORD)).rejects.toThrow(/collides/);
    await fixture.enroll("é");
    expect(await probeRetiredCredential("e\u0301", "personal")).toBeNull();
    expect(await probeRetiredCredential("é", "personal")).not.toBeNull();
  });
  // This journey performs repeated real 64 MiB Argon2id checks. Keep the
  // production cost intact while allowing a contended full-suite runner.
  it(
    "bounds traps, rejects duplicate enrollment and blocks credential reuse",
    { timeout: 120_000 },
    async () => {
      await fixture.enroll("one");
      await expect(fixture.enroll("one")).rejects.toThrow(/collides/);
      await expect(
        assertNotRetiredCredential("one", "personal"),
      ).rejects.toThrow(/Remove/);
      expect(retiredCredentialStatus("personal").events).toHaveLength(0);
      await fixture.enroll("two");
      await fixture.enroll("three");
      await expect(fixture.enroll("four")).rejects.toThrow(/maximum 3/);
    },
  );
  it("requires fresh authentication for removal and clearing and refuses decoy owners", async () => {
    await fixture.enroll("old", "synthetic_decoy");
    const trap = await probeRetiredCredential("old", "personal");
    expect(trap?.response).toBe("synthetic_decoy");
    await expect(
      removeRetiredCredential({
        tomb: "personal",
        currentPassword: "wrong",
        id: trap?.id ?? "",
      }),
    ).rejects.toThrow();
    await clearRetiredCredentialEvents({
      tomb: "personal",
      currentPassword: PASSWORD,
    });
    expect(retiredCredentialStatus("personal").events).toHaveLength(0);
    fixture.store.lock();
    await fixture.store.createGuest({ decoy: true, resume: false });
    await expect(fixture.enroll("another")).rejects.toThrow(/session/);
    fixture.store.lock();
    await fixture.store.unlock(PASSWORD);
    await removeRetiredCredential({
      tomb: "personal",
      currentPassword: PASSWORD,
      id: trap?.id ?? "",
    });
    expect(await probeRetiredCredential("old", "personal")).toBeNull();
  });
  it("fails closed on corrupt storage rather than treating it as no match", async () => {
    await fixture.enroll();
    kvSet(TRAPS_KEY, '{"v":1,"tomb":"personal","traps":[{}],"events":[]}');
    await expect(
      probeRetiredCredential("anything", "personal"),
    ).rejects.toThrow(/unavailable/);
  });
  it("refuses owner session changes during credential checks", async () => {
    retiredCredentialStorageSeams.refresh = async () => {
      fixture.store.lock();
    };
    await expect(fixture.enroll()).rejects.toThrow(/authenticate again/);
    expect(kvGet(TRAPS_KEY)).toBeNull();
  });
  it("bounds synthetic interaction evidence and accepts only a selected synthetic trap", async () => {
    await fixture.enroll("old", "synthetic_decoy");
    const trap = retiredCredentialStatus("personal").traps[0];
    if (!trap) throw new Error("Missing fixture trap");
    await recordRetiredDecoyInteraction(
      "personal",
      "other-trap",
      "vault_write",
    );
    expect(retiredCredentialStatus("personal").events).toHaveLength(0);
    for (let i = 0; i < 34; i++)
      await recordRetiredDecoyInteraction(
        "personal",
        trap.id,
        "authority_denied",
      );
    const events = retiredCredentialStatus("personal").events;
    expect(events).toHaveLength(32);
    expect(events[0]).toMatchObject({
      type: "synthetic_decoy_interaction",
      trapId: trap.id,
      action: "authority_denied",
    });
    kvSet(TRAPS_KEY, "corrupt");
    await expect(
      recordRetiredDecoyInteraction("personal", trap.id, "vault_write"),
    ).resolves.toBeUndefined();
  });
  it("refreshes bounded disk evidence before reviewing an already-open owner tab", async () => {
    await fixture.enroll();
    const disk = parseRetiredCredentialRecords(
      kvGet(TRAPS_KEY) ?? "",
      "personal",
    );
    const trap = disk.traps[0];
    if (!trap) throw new Error("Missing fixture trap");
    disk.events.push({
      type: "retired_credential_observed",
      trapId: trap.id,
      at: new Date().toISOString(),
      response: trap.response,
    });
    expect(retiredCredentialStatus("personal").events).toHaveLength(0);
    retiredCredentialStorageSeams.refresh = async (key, limit) => {
      expect(key).toBe(TRAPS_KEY);
      expect(limit).toBe(32768);
      kvSet(key, JSON.stringify(disk));
    };
    expect(
      (await refreshRetiredCredentialStatus("personal")).events,
    ).toHaveLength(1);
  });
});
