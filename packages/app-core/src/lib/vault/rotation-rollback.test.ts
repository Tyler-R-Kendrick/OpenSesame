import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { kvDelete, kvGet } from "../kv.js";
import {
  BODY_PATH,
  HEADER_PATH,
  INDEX_PATH,
  PERSONAL_TOMB,
  readFile,
  tombFileKey,
  vfsSeams,
  writeFile,
} from "../vfs.js";
import { clearVaultSurface } from "./protection/protector-enrollment.test-support.js";
import { ROTATION_JOURNAL_PATH } from "./rotation-journal.js";
import { VaultStore } from "./store.js";

const OLD_PIN = "48291037";
const NEW_PIN = "73920146";
const FILE = "settings/rollback-proof";
const bytes = new Uint8Array([9, 2, 6, 5]);
const key = (path: string) => tombFileKey(PERSONAL_TOMB, path);
const JOURNAL = key(ROTATION_JOURNAL_PATH);
let store: VaultStore;
let before: Map<string, string | null>;

beforeEach(async () => {
  await clearVaultSurface();
  kvDelete(JOURNAL);
  kvDelete(key(FILE));
  store = new VaultStore();
  await store.createWithPin(OLD_PIN);
  await writeFile(PERSONAL_TOMB, FILE, bytes);
  before = new Map(
    [HEADER_PATH, BODY_PATH, INDEX_PATH, FILE].map((path) => [
      key(path),
      kvGet(key(path)),
    ]),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  store.lock();
});

it("restores exact old ciphertext after a refused header write without retrying that writer", async () => {
  const write = vfsSeams.writeRaw;
  let refused = 0;
  vi.spyOn(vfsSeams, "writeRaw").mockImplementation(async (path, value) => {
    if (path === key(HEADER_PATH)) {
      refused++;
      throw new Error("header I/O refused");
    }
    return write(path, value);
  });
  await expect(
    store.protection.rotateCompromisedRoot({ pin: NEW_PIN }),
  ).rejects.toThrow("header I/O refused");
  expect(refused).toBe(1);
  for (const [path, raw] of before) expect(kvGet(path)).toBe(raw);
  expect(kvGet(JOURNAL)).toBeNull();
  expect(await readFile(PERSONAL_TOMB, FILE)).toEqual(bytes);
  vi.restoreAllMocks();
  store.lock();
  await store.unlockWithPin(OLD_PIN);
  expect(await readFile(PERSONAL_TOMB, FILE)).toEqual(bytes);
});

it("retains a ciphertext recovery journal when restoring an old file also fails", async () => {
  const write = vfsSeams.writeRaw;
  let rollbackRefused = false;
  vi.spyOn(vfsSeams, "writeRaw").mockImplementation(async (path, value) => {
    if (path === key(INDEX_PATH)) throw new Error("index I/O refused");
    if (path === key(FILE) && value === before.get(path)) {
      rollbackRefused = true;
      throw new Error("rollback I/O refused");
    }
    return write(path, value);
  });
  await expect(
    store.protection.rotateCompromisedRoot({ pin: NEW_PIN }),
  ).rejects.toThrow("index I/O refused");
  expect(rollbackRefused).toBe(true);
  expect(kvGet(key(HEADER_PATH))).toBe(before.get(key(HEADER_PATH)));
  expect(kvGet(JOURNAL)).not.toBeNull();
  vi.restoreAllMocks();
  store.lock();
  await store.unlockWithPin(NEW_PIN);
  expect(await readFile(PERSONAL_TOMB, FILE)).toEqual(bytes);
  expect(kvGet(JOURNAL)).toBeNull();
  store.lock();
  await expect(store.unlockWithPin(OLD_PIN)).rejects.toThrow();
});

it("never restores old ciphertext after the new header has been published", async () => {
  const remove = vfsSeams.deleteRaw;
  vi.spyOn(vfsSeams, "deleteRaw").mockImplementation(async (path) => {
    if (path === JOURNAL) throw new Error("journal cleanup I/O refused");
    return remove(path);
  });
  await expect(
    store.protection.rotateCompromisedRoot({ pin: NEW_PIN }),
  ).rejects.toThrow("journal cleanup I/O refused");
  for (const [path, raw] of before) expect(kvGet(path)).not.toBe(raw);
  expect(kvGet(JOURNAL)).not.toBeNull();
  vi.restoreAllMocks();
  store.lock();
  await store.unlockWithPin(NEW_PIN);
  expect(await readFile(PERSONAL_TOMB, FILE)).toEqual(bytes);
  expect(kvGet(JOURNAL)).toBeNull();
});

it("keeps the journal when the original store locks as a ciphertext write completes", async () => {
  const write = vfsSeams.writeRaw;
  let changed = false;
  vi.spyOn(vfsSeams, "writeRaw").mockImplementation(async (path, value) => {
    await write(path, value);
    if (!changed && path === key(FILE)) {
      changed = true;
      store.lock();
    }
  });
  await expect(
    store.protection.rotateCompromisedRoot({ pin: NEW_PIN }),
  ).rejects.toThrow();
  expect(changed).toBe(true);
  expect(kvGet(key(HEADER_PATH))).toBe(before.get(key(HEADER_PATH)));
  expect(kvGet(key(FILE))).not.toBe(before.get(key(FILE)));
  expect(kvGet(JOURNAL)).not.toBeNull();
  vi.restoreAllMocks();
  await store.unlockWithPin(NEW_PIN);
  expect(await readFile(PERSONAL_TOMB, FILE)).toEqual(bytes);
  expect(kvGet(JOURNAL)).toBeNull();
});

it("stops restoration when the original owner is revoked during a rollback write", async () => {
  const write = vfsSeams.writeRaw;
  let revoked = false;
  vi.spyOn(vfsSeams, "writeRaw").mockImplementation(async (path, value) => {
    if (path === key(INDEX_PATH)) throw new Error("index I/O refused");
    await write(path, value);
    if (path === key(FILE) && value === before.get(path)) {
      revoked = true;
      store.lock();
    }
  });
  await expect(
    store.protection.rotateCompromisedRoot({ pin: NEW_PIN }),
  ).rejects.toThrow("index I/O refused");
  expect(revoked).toBe(true);
  expect(kvGet(key(HEADER_PATH))).toBe(before.get(key(HEADER_PATH)));
  expect(kvGet(JOURNAL)).not.toBeNull();
  vi.restoreAllMocks();
  await store.unlockWithPin(NEW_PIN);
  expect(await readFile(PERSONAL_TOMB, FILE)).toEqual(bytes);
  expect(kvGet(JOURNAL)).toBeNull();
});
