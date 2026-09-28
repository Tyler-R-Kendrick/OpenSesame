/**
 * The at-rest seal on the stores that are not Web Storage (ADR 0148): the
 * browser's key record, IndexedDB rows and origin-private files.
 */
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { overlapCast } from "@opensesame/os-domain";
import { afterEach, describe, expect, it } from "vitest";
import { configureHost } from "../../host.js";
import { loadAtRestKeyFile } from "../../node/at-rest-key-file.js";
import { createTestHost } from "../../test-host.js";
import {
  listHistoryAccounts,
  listHistoryEntries,
  putHistoryAccount,
  appendHistoryEntry,
  resetHistoryBackupMemory,
} from "../history-backup-idb.js";
import {
  AT_REST_DATABASE,
  HISTORY_BACKUP_DATABASE,
} from "../storage-ownership.js";
import { isSealedAtRest, sealAtRest, atRestBinding } from "./cipher.js";
import { fakeIndexedDb, rawRows } from "./fake-idb.test-support.js";
import { loadIndexedDbAtRestKey } from "./idb-key-store.js";
import { forgetAtRestKeyForTest } from "./key.js";
import {
  openOriginFile,
  sealLegacyOriginFiles,
  sealedFileBound,
} from "./origin-files.js";

afterEach(() => {
  forgetAtRestKeyForTest();
  resetHistoryBackupMemory();
  configureHost(createTestHost());
});

describe("the browser's key record", () => {
  it("keeps the data key only wrapped, under a key script cannot read", async () => {
    const { factory, databases } = fakeIndexedDb();
    configureHost(createTestHost({ indexedDB: factory }));

    const key = await loadIndexedDbAtRestKey();
    expect(key).toHaveLength(32);
    const [record] = rawRows(databases, AT_REST_DATABASE, "keys");
    const wrappingKey: CryptoKey = overlapCast(record?.wrappingKey);
    expect(wrappingKey.extractable).toBe(false);
    const wrapped = new Uint8Array(overlapCast(record?.wrapped));
    expect(Buffer.from(wrapped).includes(Buffer.from(key))).toBe(false);

    // The next document unwraps the same key.
    expect(await loadIndexedDbAtRestKey()).toEqual(key);
  });

  it("agrees on one key when two tabs mint at once", async () => {
    const { factory } = fakeIndexedDb();
    configureHost(createTestHost({ indexedDB: factory }));
    const [one, two] = await Promise.all([
      loadIndexedDbAtRestKey(),
      loadIndexedDbAtRestKey(),
    ]);
    expect(one).toEqual(two);
  });
});

describe("IndexedDB history rows", () => {
  it("never rest with the credential handle in the clear", async () => {
    const { factory, databases } = fakeIndexedDb();
    configureHost(createTestHost({ indexedDB: factory }));
    await putHistoryAccount({
      id: "hacc_1",
      providerId: "neon",
      anonToken: "anon-secret-handle",
      claimState: "provisional",
      createdAt: "2026-09-28T00:00:00Z",
    });
    await appendHistoryEntry("hacc_1", new Uint8Array([1, 2, 3]));

    const accounts = rawRows(databases, HISTORY_BACKUP_DATABASE, "accounts");
    expect(JSON.stringify(accounts)).not.toContain("anon-secret-handle");
    expect(JSON.stringify(accounts)).not.toContain("neon");
    const entries = rawRows(databases, HISTORY_BACKUP_DATABASE, "entries");
    expect(Object.keys(entries[0] ?? {}).sort()).toEqual([
      "accountId",
      "id",
      "sealed",
    ]);

    resetHistoryBackupMemory();
    const [account] = await listHistoryAccounts();
    expect(account?.anonToken).toBe("anon-secret-handle");
    expect(await listHistoryEntries("hacc_1")).toHaveLength(1);
  });

  it("seals a row an older build left in the clear", async () => {
    const { factory, databases } = fakeIndexedDb();
    configureHost(createTestHost({ indexedDB: factory }));
    await listHistoryAccounts();
    databases
      .get(HISTORY_BACKUP_DATABASE)
      ?.get("accounts")
      ?.rows.set("hacc_old", {
        id: "hacc_old",
        providerId: "neon",
        anonToken: "old-handle",
        claimState: "claimed",
        createdAt: "2026-01-01T00:00:00Z",
      });
    resetHistoryBackupMemory();
    const accounts = await listHistoryAccounts();
    expect(accounts.map((a) => a.anonToken)).toContain("old-handle");
    const raw = rawRows(databases, HISTORY_BACKUP_DATABASE, "accounts");
    expect(JSON.stringify(raw)).not.toContain("old-handle");
  });
});

type Files = Map<string, string>;

function opfs(files: Files) {
  const root = {
    async *keys() {
      yield* [...files.keys()];
    },
    async getFileHandle(name: string) {
      if (!files.has(name)) throw new DOMException("gone", "NotFoundError");
      const blob = () => new Blob([files.get(name) ?? ""]);
      return {
        getFile: async () => blob(),
        createWritable: async () => ({
          write: async (text: string) => {
            files.set(name, text);
          },
          close: async () => {},
        }),
      };
    },
  };
  return { originFiles: () => Promise.resolve(overlapCast(root)) };
}

describe("origin-private files", () => {
  it("seals every file of ours left in the clear, and nobody else's", async () => {
    const files: Files = new Map([
      ["opensesame-pages-tomb_personal_header.json", '{"kdf":"argon2id"}'],
      ["opensesame-pages-guest-access.v1.json", '{"allow":true}'],
      ["their-notes.json", "theirs"],
    ]);
    configureHost(createTestHost(opfs(files)));

    expect(await sealLegacyOriginFiles()).toBe(2);
    const header = files.get("opensesame-pages-tomb_personal_header.json");
    expect(isSealedAtRest(header ?? "")).toBe(true);
    expect(header).not.toContain("argon2id");
    expect(files.get("their-notes.json")).toBe("theirs");
    expect(
      await openOriginFile("opensesame-pages-tomb_personal_header.json", header ?? ""),
    ).toBe('{"kdf":"argon2id"}');
    expect(await sealLegacyOriginFiles()).toBe(0);
  });

  it("bounds a sealed file by what its plaintext may be", () => {
    const key = new Uint8Array(32);
    const text = "x".repeat(1000);
    const sealed = sealAtRest(key, atRestBinding("origin-file", "f"), text);
    expect(sealed.length).toBeLessThanOrEqual(sealedFileBound(1000));
  });
});

describe("the CLI's key file", () => {
  it("is created once, owner-only, and read back the same", () => {
    const dir = mkdtempSync(join(tmpdir(), "at-rest-"));
    const path = join(dir, "state", "at-rest.key");
    const key = loadAtRestKeyFile(path);
    expect(key).toHaveLength(32);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(loadAtRestKeyFile(path)).toEqual(key);
    expect(readFileSync(path, "utf8").trim().length).toBeGreaterThan(0);
  });
});
