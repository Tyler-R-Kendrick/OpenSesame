import { mintVaultKey, sealJson } from "@opensesame/vault-core";
import { afterEach, expect, it, vi } from "vitest";
import { HEADER_PATH, tombFileKey, vfsSeams } from "../vfs.js";
import {
  ROTATION_JOURNAL_PATH,
  commitRotationJournal,
  prepareRotationJournal,
} from "./rotation-journal.js";
afterEach(() => vi.restoreAllMocks());
it("retains recovery evidence when storage acknowledges a header write without publishing it", async () => {
  const tomb = "rotation-unpublished-header";
  const { vaultKey } = await mintVaultKey();
  const seal = JSON.stringify(await sealJson(vaultKey, { synthetic: true }));
  const previousHeader = '{"revision":1}';
  const headerKey = tombFileKey(tomb, HEADER_PATH);
  const journalKey = tombFileKey(tomb, ROTATION_JOURNAL_PATH);
  const disk = new Map([[headerKey, previousHeader]]);
  const deleted: string[] = [];
  vi.spyOn(vfsSeams, "readRaw").mockImplementation(
    (key) => disk.get(key) ?? null,
  );
  vi.spyOn(vfsSeams, "writeRaw").mockImplementation(async (key, value) => {
    if (key !== headerKey) disk.set(key, value);
  });
  vi.spyOn(vfsSeams, "deleteRaw").mockImplementation(async (key) => {
    deleted.push(key);
    disk.delete(key);
  });
  const serialized = prepareRotationJournal({
    tomb,
    token: "next",
    previousHeader,
    nextHeader: '{"revision":2}',
    files: { body: seal, index: seal },
  });
  await expect(
    commitRotationJournal(tomb, serialized, () => {}),
  ).rejects.toThrow("publication failed");
  expect(disk.get(headerKey)).toBe(previousHeader);
  expect(disk.get(journalKey)).toBe(serialized);
  expect(deleted).toEqual([]);
});
