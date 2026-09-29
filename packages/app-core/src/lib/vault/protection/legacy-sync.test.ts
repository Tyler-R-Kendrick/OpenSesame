import { beforeEach, describe, expect, it } from "vitest";
import { kvDelete } from "../../kv.js";
import {
  BODY_PATH,
  HEADER_PATH,
  INDEX_PATH,
  MIGRATION_MARKER_PATH,
  PERSONAL_TOMB,
  tombFileKey,
  vfsFlush,
} from "../../vfs.js";
import { ATTEMPTS_KEY, VaultStore } from "../store.js";

const PASSWORD = "correct horse battery staple";
const PIN = "73915248";

async function openStore(): Promise<VaultStore> {
  await vfsFlush();
  kvDelete(ATTEMPTS_KEY);
  for (const path of [
    HEADER_PATH,
    BODY_PATH,
    MIGRATION_MARKER_PATH,
    INDEX_PATH,
  ]) {
    kvDelete(tombFileKey(PERSONAL_TOMB, path));
  }
  const store = new VaultStore();
  await store.create(PASSWORD);
  await store.protection.ensureProtectionProjected();
  return store;
}

const kinds = (store: VaultStore) =>
  store.protection.listProtectors().map((record) => record.kind);

describe("the manifest follows the header's own wraps", () => {
  let store: VaultStore;
  beforeEach(async () => {
    store = await openStore();
  });

  it("lists a PIN enrolled after the first projection, and drops it when removed", async () => {
    expect(kinds(store)).toEqual(["password"]);
    await store.enrollPin(PIN);
    expect(kinds(store)).toEqual(["password"]);
    await store.protection.ensureProtectionProjected();
    expect(kinds(store)).toEqual(["password", "pin"]);

    await store.removePin();
    await store.protection.ensureProtectionProjected();
    expect(kinds(store)).toEqual(["password"]);
  });

  it("keeps a protector's id and what was proved about it across a sync", async () => {
    await store.enrollPin(PIN);
    await store.protection.ensureProtectionProjected();
    const before = store.protection.listProtectors();
    await store.protection.ensureProtectionProjected();
    expect(store.protection.listProtectors()).toEqual(before);
  });

  it("writes nothing when the header and manifest already agree", async () => {
    const revision = store.getSnapshot().header?.protection?.revision;
    await store.protection.ensureProtectionProjected();
    await store.protection.ensureProtectionProjected();
    expect(store.getSnapshot().header?.protection?.revision).toBe(revision);
  });

  it("leaves a protector the manifest enrolled itself alone, and re-seals a manifest that verifies", async () => {
    const recovery = await store.protection.enrollCandidate("recovery-key");
    await store.protection.commitEnrollment(recovery.operationId);
    await store.enrollPin(PIN);
    await store.protection.ensureProtectionProjected();
    expect(kinds(store)).toEqual(["password", "recovery-key", "pin"]);

    await store.removePin();
    await store.protection.ensureProtectionProjected();
    expect(kinds(store)).toEqual(["password", "recovery-key"]);

    store.lock();
    const again = new VaultStore();
    await again.unlock(PASSWORD);
    const header = again.getSnapshot().header;
    expect(header?.protection?.records.map((record) => record.kind)).toEqual([
      "password",
      "recovery-key",
    ]);
    // The MAC verifies under the root: an action on it reaches the service's own
    // answer, not a manifest_auth_failed.
    await expect(
      again.protection.testProtector(
        header?.protection?.records[0]?.protectorId ?? "",
      ),
    ).rejects.toMatchObject({ code: "unavailable" });
  });

  it("clears a preferred protector whose wrap went away", async () => {
    await store.enrollPin(PIN);
    await store.protection.ensureProtectionProjected();
    const pin = store.protection.listProtectors().find((r) => r.kind === "pin");
    await store.protection.setPreferred(pin?.protectorId ?? "");
    await store.removePin();
    await store.protection.ensureProtectionProjected();
    expect(
      store.getSnapshot().header?.protection?.preferredProtectorId,
    ).toBeUndefined();
  });
});
