import { overlapCast } from "@opensesame/os-domain";
import {
  type AccountItem,
  createItem,
  createVault,
  manualPassword,
  outsideAccounts,
} from "@opensesame/vault-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configureHost } from "../../host.js";
import { createTestHost } from "../../test-host.js";
import { pepperedAccount } from "../account.test-support.js";
import {
  type FakeDatabases,
  fakeIndexedDb,
  rawRows,
} from "../at-rest/fake-idb.test-support.js";
import { forgetAtRestKeyForTest } from "../at-rest/key.js";
import {
  clearLocalBackupTarget,
  writeLocalBackupTarget,
} from "../backup-target-local.js";
import {
  appendHistoryEntry,
  putHistoryAccount,
  resetHistoryBackupMemory,
} from "../history-backup-idb.js";
import { kvDelete, kvSet } from "../kv.js";
import { loadSettings, saveSettings } from "../settings.js";
import { PASSWORD_HISTORY_DATABASE } from "../storage-ownership.js";
import {
  BODY_PATH,
  HEADER_PATH,
  INDEX_PATH,
  PERSONAL_TOMB,
  tombFileKey,
} from "../vfs.js";
import {
  PasswordUsedBeforeError,
  noteRetiredPassword,
  passwordPreviouslyUsed,
  preparePasswordRetirement,
  resetPasswordHistoryForTest,
} from "./password-history.js";
import { VaultStore } from "./store.js";

const SECRET = "retired-fjord-lantern-cobalt-9f3a";
const NEXT = "marina-beacon-trellis-4c8e";
const MASTER = "correct horse battery staple";
const SCOPE = `${PERSONAL_TOMB}\u0000item-1`;
const HEADER_KEY = tombFileKey(PERSONAL_TOMB, HEADER_PATH);
const BODY_KEY = tombFileKey(PERSONAL_TOMB, BODY_PATH);
const INDEX_KEY = tombFileKey(PERSONAL_TOMB, INDEX_PATH);
let databases: FakeDatabases = new Map();

beforeEach(() => {
  const fake = fakeIndexedDb();
  databases = fake.databases;
  configureHost(createTestHost({ indexedDB: fake.factory }));
});

function enableBackup(enabled = true): void {
  writeLocalBackupTarget({
    kind: "github_app",
    providerId: "github",
    connectionId: null,
    integrationId: "gh",
    installationId: "99",
    owner: "octocat",
    repo: "passwords",
    branch: "main",
    enabled,
    status: "pending",
    lastCommitSha: null,
    lastSyncedAt: null,
    lastError: null,
    config: null,
    pendingEvents: 0,
  });
}

afterEach(() => {
  forgetAtRestKeyForTest();
  resetPasswordHistoryForTest();
  resetHistoryBackupMemory();
  clearLocalBackupTarget();
  kvDelete("settings.v1");
  kvDelete(HEADER_KEY);
  kvDelete(BODY_KEY);
  kvDelete(INDEX_KEY);
  configureHost(createTestHost());
});

describe("retired password digests", () => {
  it("seals the digest and never the password", async () => {
    await noteRetiredPassword(SCOPE, SECRET);

    const rows = rawRows(databases, PASSWORD_HISTORY_DATABASE, "digests");
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual([
      "id",
      "scope",
      "sealed",
    ]);
    expect(JSON.stringify(rows)).not.toContain(SECRET);
    expect(String(rows[0]?.sealed)).toMatch(/^osr2\./);

    resetPasswordHistoryForTest();
    expect(await passwordPreviouslyUsed(SCOPE, SECRET)).toBe(true);
    expect(await passwordPreviouslyUsed(SCOPE, NEXT)).toBe(false);
    expect(
      await passwordPreviouslyUsed(`${PERSONAL_TOMB}\u0000other`, SECRET),
    ).toBe(false);
  });

  it("ignores a plaintext row and a history-backup record", async () => {
    await noteRetiredPassword(`${SCOPE}-other`, NEXT);
    await putHistoryAccount({
      id: "hacc_1",
      providerId: "github",
      anonToken: SECRET,
      claimState: "provisional",
      createdAt: "2026-09-29T00:00:00Z",
    });
    await appendHistoryEntry("hacc_1", new TextEncoder().encode(SECRET));
    databases
      .get(PASSWORD_HISTORY_DATABASE)
      ?.get("digests")
      ?.rows.set(
        "plain",
        overlapCast({ id: "plain", scope: SCOPE, password: SECRET }),
      );
    resetPasswordHistoryForTest();

    expect(await passwordPreviouslyUsed(SCOPE, SECRET)).toBe(false);
  });

  it("does not record or consult digests while a backup is configured", async () => {
    await noteRetiredPassword(SCOPE, SECRET);
    enableBackup();
    expect(await passwordPreviouslyUsed(SCOPE, SECRET)).toBe(false);
    await noteRetiredPassword(SCOPE, NEXT);
    clearLocalBackupTarget();
    resetPasswordHistoryForTest();
    expect(await passwordPreviouslyUsed(SCOPE, SECRET)).toBe(true);
    expect(await passwordPreviouslyUsed(SCOPE, NEXT)).toBe(false);
    expect(
      JSON.stringify(rawRows(databases, PASSWORD_HISTORY_DATABASE, "digests")),
    ).not.toContain(NEXT);
  });

  it("treats a history remote or connection as persistence", async () => {
    const current = loadSettings();
    saveSettings({
      ...current,
      capabilityConnectors: {
        ...current.capabilityConnectors,
        history: {
          providerId: "github",
          selections: [
            {
              providerId: "github",
              group: "git",
              remote: "https://github.com/octocat/passwords.git",
            },
          ],
        },
      },
    });
    await noteRetiredPassword(SCOPE, SECRET);
    kvDelete("settings.v1");
    expect(await passwordPreviouslyUsed(SCOPE, SECRET)).toBe(false);

    saveSettings({
      ...loadSettings(),
      capabilityConnectors: {
        ...loadSettings().capabilityConnectors,
        history: {
          providerId: "github",
          selections: [
            { providerId: "github", group: "git", connectionId: "conn_1" },
          ],
        },
      },
    });
    await noteRetiredPassword(SCOPE, SECRET);
    kvDelete("settings.v1");
    resetPasswordHistoryForTest();
    expect(await passwordPreviouslyUsed(SCOPE, SECRET)).toBe(false);
  });

  it("still records when history has no remote and backup is off", async () => {
    enableBackup(false);
    const current = loadSettings();
    saveSettings({
      ...current,
      capabilityConnectors: {
        ...current.capabilityConnectors,
        history: { providerId: "github", selections: [] },
      },
    });
    await noteRetiredPassword(SCOPE, SECRET);
    resetPasswordHistoryForTest();
    expect(await passwordPreviouslyUsed(SCOPE, SECRET)).toBe(true);
  });
});

/** The account with its one password method set to `password`. */
function withPassword(item: AccountItem, password: string): void {
  item.methods = [
    manualPassword(`${item.id}:password`, password, item.updatedAt),
  ];
}

function passwordOf(item: AccountItem | undefined): string {
  const method = item?.methods.find((entry) => entry.type === "password");
  return method?.type === "password" ? method.secret : "";
}

describe("password retirement per method", () => {
  it("records nothing for a peppered password, before or after", async () => {
    const plain = createItem("account", "Bank");
    withPassword(plain, SECRET);
    const peppered = await pepperedAccount(
      "Bank",
      "the-peppered-password",
      "pepper",
    );
    const sealed: AccountItem = { ...peppered, id: plain.id };
    sealed.methods = peppered.methods.map((method) => ({
      ...method,
      id: `${plain.id}:password`,
    }));
    // Plain -> peppered retires the plain digest; the sealed one has none.
    const retired = await preparePasswordRetirement(
      PERSONAL_TOMB,
      [plain],
      [sealed],
    );
    expect(retired).toHaveLength(1);
    expect(retired[0]?.scope).toBe(`${PERSONAL_TOMB}\u0000${plain.id}`);
    // Peppered -> peppered with a new seal: no plaintext, so nothing to retire.
    const again = await preparePasswordRetirement(
      PERSONAL_TOMB,
      [sealed],
      [{ ...sealed, methods: sealed.methods.map((m) => ({ ...m })) }],
    );
    expect(again).toEqual([]);
    const fresh = await preparePasswordRetirement(PERSONAL_TOMB, [], [sealed]);
    expect(fresh).toEqual([]);
  });

  it("keeps a second password method's history apart", async () => {
    const item = createItem("account", "Bank");
    withPassword(item, SECRET);
    const second = manualPassword(`${item.id}:other`, NEXT, item.updatedAt);
    const next: AccountItem = { ...item, methods: [...item.methods, second] };
    expect(
      await preparePasswordRetirement(PERSONAL_TOMB, [item], [next]),
    ).toEqual([]);
    const rotated: AccountItem = {
      ...next,
      methods: [
        next.methods[0] ?? second,
        { ...second, secret: "another-fresh-password-1" },
      ],
    };
    const retired = await preparePasswordRetirement(
      PERSONAL_TOMB,
      [next],
      [rotated],
    );
    expect(retired.map((note) => note.scope)).toEqual([
      `${PERSONAL_TOMB}\u0000${item.id}\u0000${item.id}:other`,
    ]);
  });
});

describe("VaultStore password retirement", () => {
  async function unlocked(): Promise<VaultStore> {
    const { header } = await createVault(MASTER);
    kvSet(HEADER_KEY, JSON.stringify(header));
    const store = new VaultStore();
    await store.unlock(MASTER);
    return store;
  }

  it("refuses a retired account password and keeps the current one", async () => {
    const store = await unlocked();
    const item = createItem("account", "Bank");
    withPassword(item, SECRET);
    await store.saveItem(item);
    withPassword(item, NEXT);
    await store.saveItem(item);
    withPassword(item, SECRET);
    await expect(store.saveItem(item)).rejects.toBeInstanceOf(
      PasswordUsedBeforeError,
    );
    const saved = store.getSnapshot().items.find((row) => row.id === item.id);
    expect(passwordOf(saved?.kind === "account" ? saved : undefined)).toBe(
      NEXT,
    );
    expect(
      JSON.stringify(rawRows(databases, PASSWORD_HISTORY_DATABASE, "digests")),
    ).not.toContain(SECRET);

    withPassword(item, NEXT);
    await store.saveItem(item);
    const other = createItem("account", "Shop");
    withPassword(other, SECRET);
    await store.saveItem(other);
  });

  it("refuses a retired secret value", async () => {
    const store = await unlocked();
    const item = createItem("secret", "Token");
    item.value = SECRET;
    await store.saveItem(item);
    item.value = NEXT;
    await store.saveItem(item);
    item.value = SECRET;
    await expect(store.saveItem(item)).rejects.toThrow(/used before/);
  });

  it("does not record a retired password when a backup is enabled", async () => {
    const store = await unlocked();
    enableBackup();
    const item = createItem("account", "Bank");
    withPassword(item, SECRET);
    await store.saveItem(item);
    withPassword(item, NEXT);
    await store.saveItem(item);
    withPassword(item, SECRET);
    await store.saveItem(item);
    clearLocalBackupTarget();
    resetPasswordHistoryForTest();
    expect(
      await passwordPreviouslyUsed(`${PERSONAL_TOMB}\u0000${item.id}`, SECRET),
    ).toBe(false);
  });

  it("rolls back a batch when one password was used before", async () => {
    const store = await unlocked();
    const item = createItem("account", "Bank");
    withPassword(item, SECRET);
    await store.saveItem(item);
    withPassword(item, NEXT);
    await store.saveItem(item);
    withPassword(item, SECRET);
    const extra = createItem("account", "Extra");
    withPassword(extra, "unique-extra-password-77");
    await expect(store.saveItems([item, extra])).rejects.toBeInstanceOf(
      PasswordUsedBeforeError,
    );
    expect(
      outsideAccounts(store.getSnapshot().items).map((row) => row.name),
    ).toEqual(["Bank"]);
  });
});
