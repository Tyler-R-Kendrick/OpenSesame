import {
  importVaultKey,
  sealJson,
  unwrapRawVaultKeyFromPassword,
  vaultSealBinding,
} from "@opensesame/vault-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  ROTATION_JOURNAL_MAX_BYTES,
  ROTATION_JOURNAL_MAX_FILES,
  hasPendingRotationJournal,
} from "../vault/rotation-journal.js";
import {
  HEADER_PATH,
  INDEX_PATH,
  readFile,
  tombFileKey,
  vfsSeams,
  writeFile,
} from "../vfs.js";
import { PASSWORD, createRetiredCredentialFixture } from "./test-support.js";
let fixture: Awaited<ReturnType<typeof createRetiredCredentialFixture>>;
beforeEach(async () => {
  fixture = await createRetiredCredentialFixture();
});
afterEach(() => {
  fixture.restore();
  vi.restoreAllMocks();
});
it("rejects an authenticated oversized index before publishing any replacement ciphertext or root", async () => {
  const header = fixture.store.getSnapshot().header;
  if (!header) throw new Error("Expected owner header");
  const raw = await unwrapRawVaultKeyFromPassword(header, PASSWORD);
  const key = await importVaultKey(raw);
  raw.fill(0);
  const files = Object.fromEntries(
    Array.from({ length: ROTATION_JOURNAL_MAX_FILES }, (_, i) => [
      `proof/path${i}`,
      1,
    ]),
  );
  const index = await sealJson(
    key,
    { v: 1, files },
    vaultSealBinding("personal", INDEX_PATH),
  );
  await vfsSeams.writeRaw(
    tombFileKey("personal", INDEX_PATH),
    JSON.stringify(index),
  );
  const previous = vfsSeams.readRaw(tombFileKey("personal", HEADER_PATH));
  const write = vi.spyOn(vfsSeams, "writeRaw");
  await expect(
    fixture.store.protection.rotateCompromisedRoot({ password: PASSWORD }),
  ).rejects.toThrow(/file limit/);
  expect(write).not.toHaveBeenCalled();
  expect(vfsSeams.readRaw(tombFileKey("personal", HEADER_PATH))).toBe(previous);
  expect(hasPendingRotationJournal("personal")).toBe(false);
  expect(fixture.store.isUnlocked()).toBe(true);
});
it("rejects a genuine large sealed file before any live root or ciphertext is replaced", async () => {
  await writeFile(
    "personal",
    "proof/large.txt",
    new Uint8Array(ROTATION_JOURNAL_MAX_BYTES),
  );
  const previous = vfsSeams.readRaw(tombFileKey("personal", HEADER_PATH));
  const write = vi.spyOn(vfsSeams, "writeRaw");
  await expect(
    fixture.store.protection.rotateCompromisedRoot({ password: PASSWORD }),
  ).rejects.toThrow(/byte limit/);
  expect(write).not.toHaveBeenCalled();
  expect(vfsSeams.readRaw(tombFileKey("personal", HEADER_PATH))).toBe(previous);
  expect(hasPendingRotationJournal("personal")).toBe(false);
  expect((await readFile("personal", "proof/large.txt")).byteLength).toBe(
    ROTATION_JOURNAL_MAX_BYTES,
  );
}, 60_000);
