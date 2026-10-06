import { forgetAtRestKeyForTest } from "@opensesame/app-core/lib/at-rest/key.js";
import { freshIndexedDb } from "@opensesame/app-core/lib/encrypted-db/edb.test-support.js";
/** @vitest-environment jsdom */
import {
  appendHistoryEntry,
  installHistoryRowStore,
  listHistoryEntries,
  putHistoryAccount,
  resetHistoryBackupMemory,
} from "@opensesame/app-core/lib/history-backup-idb.js";
import { HISTORY_BACKUP_DATABASE } from "@opensesame/app-core/lib/storage-ownership.js";
import { installPasswordDigestStore } from "@opensesame/app-core/lib/vault/password-history.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  NO_SIDE_EFFECTS,
  expectLifecycle,
  importUnderSpies,
  runtimeOf,
} from "../runtime-test-kit.js";
import { createTestContext } from "../test-context.js";
import type * as Runtime from "./runtime.js";

let runtime: typeof Runtime;
beforeEach(() => {
  freshIndexedDb();
});

afterEach(() => {
  installHistoryRowStore(null);
  installPasswordDigestStore(null);
  resetHistoryBackupMemory();
  forgetAtRestKeyForTest();
});

describe("storage.encrypted-search runtime", () => {
  it("imports with no fetch, timer, DOM or storage side effect", async () => {
    const loaded = await importUnderSpies(() => import("./runtime.js"));
    runtime = loaded.module;
    expect(loaded.effects).toEqual(NO_SIDE_EFFECTS);
  });

  it("registers nothing: it routes stores, it draws no surface", async () => {
    await expectLifecycle(runtimeOf(runtime), {
      capability: "storage.encrypted-search",
      kinds: [],
      count: 0,
    });
  });

  it("keeps history in an encrypted database while active and routes back when disposed", async () => {
    const factory = freshIndexedDb();
    const names = async () =>
      (await factory.databases()).map((entry) => entry.name ?? "");
    const t = createTestContext();
    const handle = await runtime.capabilityRuntime.activate(t.ctx);

    await putHistoryAccount({
      id: "hacc_a",
      providerId: "p",
      anonToken: "t",
      claimState: "provisional",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    await appendHistoryEntry("hacc_a", new Uint8Array([1]));
    expect(await listHistoryEntries("hacc_a")).toHaveLength(1);
    expect(await names()).toEqual([
      expect.stringMatching(/^opensesame-edb-[0-9a-f]{32}$/),
      expect.stringMatching(/^opensesame-edb-[0-9a-f]{32}$/),
    ]);

    await handle.dispose();
    await putHistoryAccount({
      id: "hacc_b",
      providerId: "p",
      anonToken: "t",
      claimState: "provisional",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(await names()).toContain(HISTORY_BACKUP_DATABASE);
  });
});
