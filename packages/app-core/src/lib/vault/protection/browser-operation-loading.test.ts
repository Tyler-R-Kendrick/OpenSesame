/** Only module delivery is held; authority, MACs, capsules and storage are real. */
import { createItem } from "@opensesame/vault-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isDecoySession } from "../../duress/store/decoy-scratch.js";
import { kvDelete, kvGet } from "../../kv.js";
import { writeLastVaultId } from "../../last-vault.js";
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
import { LEGACY_PREFS_KEY } from "../tomb-migration.js";

const delivery = vi.hoisted(() => {
  function gate() {
    let announce = () => {};
    let release = () => {};
    const entered = new Promise<void>((resolve) => {
      announce = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { entered, held, announce, release };
  }
  return { enrollment: gate(), lifecycle: gate() };
});

vi.mock("./browser-enroll.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./browser-enroll.js")>();
  delivery.enrollment.announce();
  await delivery.enrollment.held;
  return actual;
});
vi.mock("./browser-lifecycle-ops.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./browser-lifecycle-ops.js")>();
  delivery.lifecycle.announce();
  await delivery.lifecycle.held;
  return actual;
});

const PASSWORD = "correct horse battery staple";
const HEADER_KEY = tombFileKey(PERSONAL_TOMB, HEADER_PATH);
const BODY_KEY = tombFileKey(PERSONAL_TOMB, BODY_PATH);
const stores: VaultStore[] = [];

async function owner(): Promise<VaultStore> {
  const store = new VaultStore();
  stores.push(store);
  await store.create(PASSWORD);
  await store.protection.ensureProtectionProjected();
  return store;
}

function passwordId(store: VaultStore): string {
  const record = store.protection
    .listProtectors()
    .find((entry) => entry.kind === "password");
  if (!record) throw new Error("The genuine owner has no password protector.");
  return record.protectorId;
}

beforeEach(async () => {
  await vfsFlush();
  kvDelete(ATTEMPTS_KEY);
  for (const path of [
    HEADER_PATH,
    BODY_PATH,
    INDEX_PATH,
    MIGRATION_MARKER_PATH,
  ]) {
    kvDelete(tombFileKey(PERSONAL_TOMB, path));
  }
  kvDelete(LEGACY_PREFS_KEY);
  writeLastVaultId(PERSONAL_TOMB);
});
afterEach(async () => {
  delivery.enrollment.release();
  delivery.lifecycle.release();
  for (const store of stores.splice(0)) store.lock();
  await vfsFlush();
});

describe.sequential(
  "deferred protector management with real owner sessions",
  () => {
    it("does not admit a cold enrollment into a fresh owner session after lock", async () => {
      const store = await owner();
      const before = kvGet(HEADER_KEY);
      const pending = store.protection.enrollCandidate("recovery-key");
      const refused = expect(pending).rejects.toMatchObject({
        code: "stale_operation",
      });
      await delivery.enrollment.entered;
      store.lock();
      await store.unlock(PASSWORD);
      delivery.enrollment.release();
      await refused;
      expect(kvGet(HEADER_KEY)).toBe(before);
      expect(
        store.protection
          .listProtectors()
          .some((entry) => entry.kind === "recovery-key"),
      ).toBe(false);
      const fresh = await store.protection.enrollCandidate("recovery-key");
      await store.protection.commitEnrollment(fresh.operationId);
      expect(
        store.protection
          .listProtectors()
          .some((entry) => entry.protectorId === fresh.record.protectorId),
      ).toBe(true);
    });

    it("does not delegate a cold lifecycle operation into a synthetic session", async () => {
      const store = await owner();
      const beforeHeader = kvGet(HEADER_KEY);
      const beforeBody = kvGet(BODY_KEY);
      const pending = store.protection.setPreferred(passwordId(store));
      const refused = expect(pending).rejects.toMatchObject({
        code: "stale_operation",
      });
      await delivery.lifecycle.entered;
      store.lock();
      await store.createGuest({ decoy: true });
      expect(isDecoySession()).toBe(true);
      delivery.lifecycle.release();
      await refused;
      expect(store.protection.listProtectors()).toEqual([]);
      expect(kvGet(HEADER_KEY)).toBe(beforeHeader);
      expect(kvGet(BODY_KEY)).toBe(beforeBody);
    });

    it("uses the cached operations for genuine enrollment, proof, removal and rotation", async () => {
      const store = await owner();
      const item = createItem("note", "kept across root rotation");
      item.notes = "genuine encrypted payload";
      await store.saveItem(item);
      const enrollment = await store.protection.enrollCandidate("recovery-key");
      const secret = enrollment.recoverySecretB64;
      if (!secret)
        throw new Error("The genuine recovery enrollment returned no secret.");
      await store.protection.commitEnrollment(enrollment.operationId);
      const tested = await store.protection.testProtector(
        enrollment.record.protectorId,
        {
          recoverySecretB64: secret,
        },
      );
      expect(tested).toMatchObject({ proofStatus: "verified" });
      await store.protection.setPreferred(enrollment.record.protectorId);
      expect(store.getSnapshot().header?.protection?.preferredProtectorId).toBe(
        enrollment.record.protectorId,
      );
      await store.protection.removeProtector(enrollment.record.protectorId);
      expect(
        store.getSnapshot().header?.protection?.preferredProtectorId,
      ).toBeUndefined();
      const epoch = store.getSnapshot().header?.protection?.rootEpoch;
      if (epoch === undefined)
        throw new Error("The owner has no authenticated root epoch.");
      await store.protection.rotateCompromisedRoot({ password: PASSWORD });
      expect(store.getSnapshot().header?.protection?.rootEpoch).toBe(epoch + 1);
      store.lock();
      await store.unlock(PASSWORD);
      expect(
        store.getSnapshot().items.find((entry) => entry.id === item.id)?.notes,
      ).toBe(item.notes);
    });

    it("refuses cached operations from the original generation even after fresh real unlock", async () => {
      const store = await owner();
      const recovery = await store.protection.enrollCandidate("recovery-key");
      const secret = recovery.recoverySecretB64;
      if (!secret)
        throw new Error("The genuine recovery enrollment returned no secret.");
      await store.protection.commitEnrollment(recovery.operationId);
      const before = kvGet(HEADER_KEY);
      const pending = [
        store.protection.setPreferred(recovery.record.protectorId),
        store.protection.removeProtector(recovery.record.protectorId),
        store.protection.testProtector(recovery.record.protectorId, {
          recoverySecretB64: secret,
        }),
        store.protection.rotateCompromisedRoot({ password: PASSWORD }),
        store.protection.enrollCandidate("recovery-key"),
      ];
      const refusals = pending.map((operation) =>
        expect(operation).rejects.toMatchObject({ code: "stale_operation" }),
      );
      store.lock();
      await store.unlock(PASSWORD);
      await Promise.all(refusals);
      expect(kvGet(HEADER_KEY)).toBe(before);
      await store.protection.setPreferred(passwordId(store));
      expect(store.getSnapshot().header?.protection?.preferredProtectorId).toBe(
        passwordId(store),
      );
    });
  },
);
