import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { kvDelete } from "./kv.js";
import {
  readTrustedUnlock,
  trustedUnlockSeams,
  writeTrustedUnlock,
} from "./trusted-unlock.js";
import { vaultStore } from "./vault/store.js";
import {
  BODY_PATH,
  HEADER_PATH,
  INDEX_PATH,
  MIGRATION_MARKER_PATH,
  PERSONAL_TOMB,
  tombFileKey,
  vfsFlush,
  writeFile,
} from "./vfs.js";

const PASSWORD = "correct horse battery staple";

const IDS = [crypto.randomUUID(), crypto.randomUUID()].map(
  (id) => `local_${id}`,
);
const original = { ...trustedUnlockSeams };

async function openVault(): Promise<void> {
  await vfsFlush();
  for (const path of [
    BODY_PATH,
    HEADER_PATH,
    INDEX_PATH,
    MIGRATION_MARKER_PATH,
  ]) {
    kvDelete(tombFileKey(PERSONAL_TOMB, path));
  }
  await vaultStore.create(PASSWORD);
}

async function closeVault(): Promise<void> {
  await vaultStore.flushPendingWrites();
  await vfsFlush();
  vaultStore.lock();
  await vaultStore.destroy();
}

beforeEach(async () => {
  await openVault();
  const directory = {
    version: 2,
    revision: 0,
    entries: IDS.map((id, index) => ({
      id,
      kind: "person",
      name: index === 0 ? "Ada" : "Ben",
      enabled: true,
    })),
    memberships: [],
  };
  const passkeys = {
    version: 1,
    passkeys: IDS.map((principalId) => ({
      principalId,
      credentialId: crypto.randomUUID(),
      publicKeyB64: "A",
      counter: 0,
      createdAt: 1,
    })),
  };
  await writeFile(
    "personal",
    "config/identity-directory",
    new TextEncoder().encode(JSON.stringify(directory)),
  );
  await writeFile(
    "personal",
    "config/identity-credentials",
    new TextEncoder().encode(JSON.stringify(passkeys)),
  );
});

afterEach(async () => {
  Object.assign(trustedUnlockSeams, original);
  await closeVault();
});

describe("trusted-contact unlock policy", () => {
  it("stores a threshold over named local people and opens only after enough of them approve", async () => {
    await writeTrustedUnlock("personal", {
      name: "Family",
      threshold: 2,
      memberIds: IDS,
    });
    expect(await readTrustedUnlock("personal")).toMatchObject({
      name: "Family",
      threshold: 2,
      memberIds: IDS,
    });

    const approved: string[] = [];
    trustedUnlockSeams.authenticate = async (_tomb, id) => {
      approved.push(id);
    };
    vaultStore.lock();
    await vaultStore.unlock(PASSWORD);
    expect(vaultStore.getSnapshot().status).not.toBe("unlocked");
    expect(vaultStore.getSnapshot().trustedUnlock).toMatchObject({
      name: "Family",
      threshold: 2,
      approved: [],
    });

    await vaultStore.confirmTrustedContact(IDS[0] ?? "");
    expect(vaultStore.getSnapshot().trustedUnlock?.approved).toEqual([IDS[0]]);
    expect(vaultStore.getSnapshot().status).not.toBe("unlocked");

    await vaultStore.confirmTrustedContact(IDS[1] ?? "");
    expect(approved).toHaveLength(2);
    expect(vaultStore.getSnapshot().status).toBe("unlocked");
    expect(vaultStore.getSnapshot().trustedUnlock).toBeNull();
  });

  it("rejects malformed policy files before a trusted-contact unlock can start", async () => {
    const policy = {
      version: 1,
      name: "Family",
      threshold: 1,
      memberIds: IDS,
      createdAt: new Date().toISOString(),
    };
    for (const invalid of [
      null,
      [],
      { ...policy, version: 2 },
      { ...policy, name: " Family " },
      { ...policy, threshold: "1" },
      { ...policy, threshold: 1.5 },
      { ...policy, threshold: 0 },
      { ...policy, threshold: 3 },
      { ...policy, memberIds: [null] },
      { ...policy, memberIds: ["remote-person"] },
      { ...policy, memberIds: [IDS[0], IDS[0]] },
      { ...policy, createdAt: null },
    ]) {
      await writeFile(
        "personal",
        "config/trusted-unlock",
        new TextEncoder().encode(JSON.stringify(invalid)),
      );
      await expect(readTrustedUnlock("personal")).rejects.toThrow(/policy/i);
    }
  });

  it("refuses a policy whose people have no passkey", async () => {
    const third = `local_${crypto.randomUUID()}`;
    await expect(
      writeTrustedUnlock("personal", {
        name: "Family",
        threshold: 1,
        memberIds: [third],
      }),
    ).rejects.toThrow(/local identity|passkey|unavailable/i);
  });
});
