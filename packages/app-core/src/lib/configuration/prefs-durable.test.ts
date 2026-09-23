import { beforeEach, describe, expect, it } from "vitest";
import { kvDelete } from "../kv.js";
import {
  ATTEMPTS_KEY,
  PREFS_CONFIG_PATH,
  PREFS_SOURCE_CONFIG_PATH,
  VaultStore,
} from "../vault/store.js";
import { LEGACY_PREFS_KEY } from "../vault/tomb-migration.js";
import {
  BODY_PATH,
  HEADER_PATH,
  INDEX_PATH,
  MIGRATION_MARKER_PATH,
  PERSONAL_TOMB,
  readFile,
  tombFileKey,
  vfsFlush,
} from "../vfs.js";
import { commitPrefsSource } from "./prefs-adapter.js";
import { prefsToYaml } from "./prefs-document.js";

const PASSWORD = "correct horse battery staple";

function clearVault(): void {
  kvDelete(ATTEMPTS_KEY);
  kvDelete(tombFileKey(PERSONAL_TOMB, HEADER_PATH));
  kvDelete(tombFileKey(PERSONAL_TOMB, BODY_PATH));
  kvDelete(LEGACY_PREFS_KEY);
  kvDelete(tombFileKey(PERSONAL_TOMB, PREFS_CONFIG_PATH));
  kvDelete(tombFileKey(PERSONAL_TOMB, PREFS_SOURCE_CONFIG_PATH));
  kvDelete(tombFileKey(PERSONAL_TOMB, MIGRATION_MARKER_PATH));
  kvDelete(tombFileKey(PERSONAL_TOMB, INDEX_PATH));
}

beforeEach(async () => {
  await vfsFlush();
  clearVault();
});

describe("durable prefs commit through VaultStore/VFS", () => {
  it("Save writes JSON and YAML sidecar; comments survive lock/unlock", async () => {
    const store = new VaultStore();
    await store.create(PASSWORD);
    const comment =
      "# keep this comment; autoLockMinutes 7 is a supported custom value\n";
    const source = `${comment}${prefsToYaml({
      theme: "dark",
      autoLockMinutes: 7,
      lockOnHide: false,
      signOutOnLock: false,
      clipboardClearSeconds: 30,
    })}`;
    const result = await commitPrefsSource(
      {
        readPrefs: () => store.getSnapshot().prefs,
        tomb: () => store.activeTomb(),
        revisionToken: () =>
          String(store.getSnapshot().prefs.prefsRevision ?? 0),
        writeSemantic: (next) => store.commitPrefs(next),
        writeSource: (yaml) => store.writePrefsSource(yaml),
        readSource: () => store.readPrefsSource(),
      },
      {
        source,
        baseRevision: String(store.getSnapshot().prefs.prefsRevision ?? 0),
      },
    );
    expect(result.status).toBe("applied_durable");
    const sealed = await readFile(store.activeTomb(), PREFS_CONFIG_PATH);
    expect(JSON.parse(new TextDecoder().decode(sealed)).autoLockMinutes).toBe(
      7,
    );
    const sidecar = await store.readPrefsSource();
    expect(sidecar).toContain("keep this comment");
    expect(sidecar).toContain("autoLockMinutes: 7");

    store.lock();
    const reopened = new VaultStore();
    await reopened.unlock(PASSWORD);
    expect(reopened.getSnapshot().prefs.theme).toBe("dark");
    expect(reopened.getSnapshot().prefs.autoLockMinutes).toBe(7);
    expect(await reopened.readPrefsSource()).toContain("keep this comment");
  });

  it("does not claim durable success when the sealed write fails", async () => {
    const store = new VaultStore();
    const result = await commitPrefsSource(
      {
        readPrefs: () => store.getSnapshot().prefs,
        tomb: () => store.activeTomb(),
        revisionToken: () => "0",
        writeSemantic: (next) => store.commitPrefs(next),
      },
      {
        source: prefsToYaml({
          theme: "dark",
          autoLockMinutes: 0,
          lockOnHide: false,
          signOutOnLock: false,
          clipboardClearSeconds: 30,
        }),
        baseRevision: "0",
      },
    );
    expect(result.status).toBe("refused");
    expect(result.message).toMatch(/Unlock|stored|lock/i);
    expect(store.getSnapshot().prefs.theme).toBe("system");
  });
});
