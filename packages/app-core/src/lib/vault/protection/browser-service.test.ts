import { overlapCast } from "@opensesame/os-domain";
import { createItem } from "@opensesame/vault-core";
import { beforeEach, describe, expect, it } from "vitest";
import { kvDelete, kvGet } from "../../kv.js";
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
import { ProtectionError } from "./errors.js";

const PASSWORD = "correct horse battery staple";
const HEADER_KEY = tombFileKey(PERSONAL_TOMB, HEADER_PATH);
const BODY_KEY = tombFileKey(PERSONAL_TOMB, BODY_PATH);

async function clearVaultSurface(): Promise<void> {
  await vfsFlush();
  kvDelete(ATTEMPTS_KEY);
  kvDelete(HEADER_KEY);
  kvDelete(BODY_KEY);
  kvDelete(tombFileKey(PERSONAL_TOMB, MIGRATION_MARKER_PATH));
  kvDelete(tombFileKey(PERSONAL_TOMB, INDEX_PATH));
  kvDelete(LEGACY_PREFS_KEY);
}

describe("VaultProtectionBrowserService", () => {
  beforeEach(async () => {
    await clearVaultSurface();
  });

  it("projects legacy protection on unlock without rewriting wrap bytes (KP-01)", async () => {
    const store = new VaultStore();
    await store.create(PASSWORD);
    const wrapBefore = store.getSnapshot().header?.wrap?.ctB64;
    const kdfBefore = store.getSnapshot().header?.kdf?.saltB64;
    store.lock();

    const unlocked = new VaultStore();
    await unlocked.unlock(PASSWORD);
    expect(unlocked.getSnapshot().header?.protection).toBeDefined();
    expect(
      unlocked.protection.listProtectors().some((r) => r.kind === "password"),
    ).toBe(true);
    expect(unlocked.getSnapshot().header?.wrap?.ctB64).toBe(wrapBefore);
    expect(unlocked.getSnapshot().header?.kdf?.saltB64).toBe(kdfBefore);

    // SAFETY: header JSON is opaque bootstrap metadata; only wrap/kdf fields are read.
    const persisted: {
      wrap?: { ctB64?: string };
      kdf?: { saltB64?: string };
      protection?: object;
    } = overlapCast(JSON.parse(kvGet(HEADER_KEY) ?? "{}"));
    expect(persisted.wrap?.ctB64).toBe(wrapBefore);
    expect(persisted.kdf?.saltB64).toBe(kdfBefore);
    expect(persisted.protection).toBeDefined();
  });

  it("persists recovery-key through lock/reload and opens the same root (KP-10)", async () => {
    const store = new VaultStore();
    await store.create(PASSWORD);
    const note = createItem("note", "canary");
    note.notes = "kp-10 payload";
    await store.saveItem(note);

    const candidate = await store.protection.enrollCandidate("recovery-key");
    expect(candidate.recoverySecretB64).toBeTruthy();
    await store.protection.commitEnrollment(candidate.operationId);
    expect(
      store.protection.listProtectors().some((r) => r.kind === "recovery-key"),
    ).toBe(true);

    const wrapCt = store.getSnapshot().header?.wrap?.ctB64;
    store.lock();

    const reloaded = new VaultStore();
    await reloaded.unlock(PASSWORD);
    expect(reloaded.getSnapshot().items.some((i) => i.name === "canary")).toBe(
      true,
    );
    expect(reloaded.getSnapshot().header?.wrap?.ctB64).toBe(wrapCt);

    const recoverySecret = candidate.recoverySecretB64;
    if (!recoverySecret) {
      throw new Error("expected recovery secret");
    }
    const opened = await reloaded.protection.openRecoveryKey(recoverySecret);
    expect(opened.byteLength).toBe(32);
    opened.fill(0);
  });

  it("leaves the previous vault usable when enrollment is canceled", async () => {
    const store = new VaultStore();
    await store.create(PASSWORD);
    store.lock();
    await store.unlock(PASSWORD);
    const before = store.protection.listProtectors().map((r) => r.protectorId);
    const wrapBefore = store.getSnapshot().header?.wrap?.ctB64;

    const candidate = await store.protection.enrollCandidate("recovery-key");
    store.protection.cancelPendingOps();
    await expect(
      store.protection.commitEnrollment(candidate.operationId),
    ).rejects.toBeInstanceOf(ProtectionError);

    expect(store.protection.listProtectors().map((r) => r.protectorId)).toEqual(
      before,
    );
    expect(store.getSnapshot().header?.wrap?.ctB64).toBe(wrapBefore);
    store.lock();
    const again = new VaultStore();
    await again.unlock(PASSWORD);
    expect(again.getSnapshot().status).toBe("unlocked");
    expect(
      again.protection.listProtectors().some((r) => r.kind === "recovery-key"),
    ).toBe(false);
  });

  it("refuses guest enrollment into another vault (KP-17)", async () => {
    const member = new VaultStore();
    await member.create(PASSWORD);
    member.lock();

    const guest = new VaultStore();
    await guest.createGuest();
    await expect(
      guest.protection.enrollCandidate("recovery-key"),
    ).rejects.toMatchObject({ code: "unavailable" });
  });

  it("setPreferred / remove / rotate lifecycle mutations", async () => {
    const store = new VaultStore();
    await store.create(PASSWORD);
    await store.protection.ensureProtectionProjected();
    const passwordId = store.protection
      .listProtectors()
      .find((r) => r.kind === "password")?.protectorId;
    if (!passwordId) throw new Error("expected password protector");

    const recovery = await store.protection.enrollCandidate("recovery-key");
    await store.protection.commitEnrollment(recovery.operationId);
    const recoveryId = recovery.record.protectorId;

    await store.protection.setPreferred(recoveryId);
    expect(store.getSnapshot().header?.protection?.preferredProtectorId).toBe(
      recoveryId,
    );

    await expect(
      store.protection.testProtector(passwordId),
    ).rejects.toMatchObject({ code: "unavailable" });
    await store.protection.removeProtector(recoveryId);
    expect(
      store.protection
        .listProtectors()
        .some((r) => r.protectorId === recoveryId),
    ).toBe(false);

    await store.protection.rotateCompromisedRoot({ password: PASSWORD });
    expect(store.getSnapshot().header?.protection?.rootEpoch).toBeGreaterThan(
      0,
    );
    store.lock();
    const again = new VaultStore();
    await again.unlock(PASSWORD);
    expect(again.getSnapshot().status).toBe("unlocked");
  });
});
