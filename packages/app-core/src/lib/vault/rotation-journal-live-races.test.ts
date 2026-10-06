import { mintVaultKey, sealJson } from "@opensesame/vault-core";
import { afterEach, expect, it, vi } from "vitest";
import {
  assertAuthenticationSession,
  markDecoySession,
} from "../decoy-session.js";
import { HEADER_PATH, tombFileKey, vfsSeams } from "../vfs.js";
import {
  ROTATION_JOURNAL_PATH,
  commitRotationJournal,
  prepareRotationJournal,
} from "./rotation-journal.js";

afterEach(() => vi.restoreAllMocks());
async function fixture(phase: "last_file" | "header_swap" | "header") {
  const tomb = `rotation-live-${phase}`;
  const { vaultKey } = await mintVaultKey();
  const seal = JSON.stringify(await sealJson(vaultKey, { synthetic: true }));
  const previousHeader = '{"revision":1}';
  const nextHeader = '{"revision":2}';
  const foreignHeader = '{"revision":3}';
  const headerKey = tombFileKey(tomb, HEADER_PATH);
  const journalKey = tombFileKey(tomb, ROTATION_JOURNAL_PATH);
  const lastKey = tombFileKey(tomb, "proof/private.txt");
  const disk = new Map([[headerKey, previousHeader]]);
  const deleted: string[] = [];
  const realm = assertAuthenticationSession();
  vi.spyOn(vfsSeams, "readRaw").mockImplementation(
    (key) => disk.get(key) ?? null,
  );
  vi.spyOn(vfsSeams, "writeRaw").mockImplementation(async (key, value) => {
    disk.set(key, value);
    // The storage completion is the event boundary, independent of checkpoint counts.
    if (key === lastKey && phase === "last_file") markDecoySession(true, tomb);
    if (key === lastKey && phase === "header_swap")
      disk.set(headerKey, foreignHeader);
    if (key === headerKey && phase === "header") markDecoySession(true, tomb);
  });
  vi.spyOn(vfsSeams, "deleteRaw").mockImplementation(async (key) => {
    deleted.push(key);
    disk.delete(key);
  });
  const serialized = prepareRotationJournal({
    tomb,
    token: "next",
    previousHeader,
    nextHeader,
    files: { body: seal, index: seal, "proof/private.txt": seal },
  });
  const run = () =>
    commitRotationJournal(tomb, serialized, () => {
      assertAuthenticationSession(realm);
    });
  return {
    run,
    disk,
    headerKey,
    journalKey,
    previousHeader,
    nextHeader,
    foreignHeader,
    serialized,
    deleted,
  };
}

it("does not publish a real header when the realm changes as the last ciphertext completes", async () => {
  const f = await fixture("last_file");
  await expect(f.run()).rejects.toThrow();
  expect(f.disk.get(f.headerKey)).toBe(f.previousHeader);
  expect(f.disk.get(f.journalKey)).toBe(f.serialized);
  expect(f.deleted).toEqual([]);
});
it("does not overwrite a successor header installed as the last ciphertext completes", async () => {
  const f = await fixture("header_swap");
  await expect(f.run()).rejects.toThrow("current header");
  expect(f.disk.get(f.headerKey)).toBe(f.foreignHeader);
  expect(f.disk.get(f.journalKey)).toBe(f.serialized);
  expect(f.deleted).toEqual([]);
});
it("retains the journal when a synthetic successor appears after actual header publication", async () => {
  const f = await fixture("header");
  await expect(f.run()).rejects.toThrow();
  expect(f.disk.get(f.headerKey)).toBe(f.nextHeader);
  expect(f.disk.get(f.journalKey)).toBe(f.serialized);
  expect(f.deleted).toEqual([]);
});
