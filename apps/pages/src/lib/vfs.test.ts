import { type BoundaryValue, overlapCast } from "@opensesame/os-domain";
import { beforeEach, describe, expect, it } from "vitest";
import { kvDelete, kvDurability, kvGet, kvHydrate, kvSet } from "./kv.js";
import {
  type SealedBlob,
  mintVaultKey,
  openJson,
  sealJson,
} from "./vault/crypto.js";
import {
  BODY_PATH,
  HEADER_PATH,
  INDEX_PATH,
  MIGRATION_MARKER_PATH,
  PERSONAL_TOMB,
  TOMBS_REGISTRY_KEY,
  VfsError,
  deleteFile,
  ensureIndexed,
  listDir,
  listTombs,
  lockAllTombs,
  readFile,
  readPlaintextFile,
  readSealedFile,
  registerTomb,
  tombFileKey,
  unlockTomb,
  unregisterTomb,
  vfsFlush,
  writeFile,
  writePlaintextFile,
  writeSealedFile,
} from "./vfs.js";

const TOMB = PERSONAL_TOMB;
const utf8 = new TextEncoder();
const utf8decode = new TextDecoder();

/** Every VFS key these tests touch, so cases cannot leak into each other. */
function clearVfs(): void {
  for (const path of [
    HEADER_PATH,
    BODY_PATH,
    INDEX_PATH,
    MIGRATION_MARKER_PATH,
    "config/prefs",
    "config/secret-name",
    "config/other",
    "drops/one",
  ]) {
    kvDelete(tombFileKey(TOMB, path));
  }
  kvDelete(TOMBS_REGISTRY_KEY);
}

beforeEach(async () => {
  await vfsFlush();
  lockAllTombs();
  clearVfs();
});

async function unlockedTomb(): Promise<CryptoKey> {
  const { vaultKey } = await mintVaultKey();
  unlockTomb(TOMB, vaultKey);
  return vaultKey;
}

describe("vfs sealed files", () => {
  it("round-trips bytes through seal and unseal", async () => {
    await unlockedTomb();
    await writeFile(TOMB, "config/prefs", utf8.encode('{"theme":"dark"}'));
    const back = await readFile(TOMB, "config/prefs");
    expect(utf8decode.decode(back)).toBe('{"theme":"dark"}');
  });

  it("stores no plaintext at rest — only the SealedBlob envelope", async () => {
    await unlockedTomb();
    await writeFile(TOMB, "config/prefs", utf8.encode("hunter2-secret"));
    const raw = kvGet(tombFileKey(TOMB, "config/prefs"));
    expect(raw).toBeTruthy();
    const parsed = overlapCast<{ ivB64?: string; ctB64?: string }>(
      JSON.parse(raw ?? "{}"),
    );
    expect(parsed.ivB64).toBeTruthy();
    expect(parsed.ctB64).toBeTruthy();
    expect(raw).not.toContain("hunter2-secret");
    expect(raw).not.toContain("config/prefs");
  });

  it("keeps file names private: the sealed index lists them only for the key", async () => {
    await unlockedTomb();
    await writeFile(TOMB, "config/secret-name", utf8.encode("x"));
    const rawIndex = kvGet(tombFileKey(TOMB, INDEX_PATH));
    expect(rawIndex).toBeTruthy();
    expect(rawIndex).not.toContain("secret-name");

    expect(await listDir(TOMB, "config/")).toEqual(["config/secret-name"]);
    expect(await listDir(TOMB, "")).toEqual(["config/secret-name"]);
    expect(await listDir(TOMB, "drops/")).toEqual([]);
  });

  it("bumps the index revision on every write", async () => {
    const vaultKey = await unlockedTomb();
    await writeFile(TOMB, "config/prefs", utf8.encode("one"));
    await writeFile(TOMB, "config/prefs", utf8.encode("two"));
    const rawIndex = kvGet(tombFileKey(TOMB, INDEX_PATH)) ?? "{}";
    const blob = overlapCast<BoundaryValue, SealedBlob>(JSON.parse(rawIndex));
    const index = await openJson<{ files: Record<string, number> }>(
      vaultKey,
      blob,
    );
    expect(index.files["config/prefs"]).toBe(2);
  });

  it("deletes a file and its index entry", async () => {
    await unlockedTomb();
    await writeFile(TOMB, "config/prefs", utf8.encode("x"));
    await writeFile(TOMB, "config/other", utf8.encode("y"));
    await deleteFile(TOMB, "config/prefs");
    expect(kvGet(tombFileKey(TOMB, "config/prefs"))).toBeNull();
    expect(await listDir(TOMB, "config/")).toEqual(["config/other"]);
    await expect(readFile(TOMB, "config/prefs")).rejects.toMatchObject({
      code: "not-found",
    });
  });

  it("refuses sealed access to a locked tomb, reads plaintext regardless", async () => {
    await writePlaintextFile(TOMB, HEADER_PATH, '{"v":1}');
    await expect(readFile(TOMB, "config/prefs")).rejects.toBeInstanceOf(
      VfsError,
    );
    await expect(
      writeFile(TOMB, "config/prefs", utf8.encode("x")),
    ).rejects.toMatchObject({ code: "locked" });
    await expect(listDir(TOMB, "config/")).rejects.toMatchObject({
      code: "locked",
    });
    // The header is the documented plaintext boundary — no key needed.
    expect(readPlaintextFile(TOMB, HEADER_PATH)).toBe('{"v":1}');
  });

  it("rejects traversal, absolute paths, and reserved files", async () => {
    await unlockedTomb();
    await expect(
      writeFile(TOMB, "../escape", utf8.encode("x")),
    ).rejects.toMatchObject({ code: "invalid-path" });
    await expect(readFile(TOMB, "/abs")).rejects.toMatchObject({
      code: "invalid-path",
    });
    await expect(
      writeFile(TOMB, INDEX_PATH, utf8.encode("x")),
    ).rejects.toMatchObject({ code: "invalid-path" });
    await expect(
      writeFile(TOMB, HEADER_PATH, utf8.encode("x")),
    ).rejects.toMatchObject({ code: "invalid-path" });
  });

  it("calls tampered ciphertext corrupt, never plaintext", async () => {
    await unlockedTomb();
    kvSet(tombFileKey(TOMB, "config/prefs"), '{"not":"sealed"}');
    await expect(readFile(TOMB, "config/prefs")).rejects.toMatchObject({
      code: "corrupt",
    });
  });
});

describe("vfs tomb registry", () => {
  it("lists tomb names only", async () => {
    await unlockedTomb();
    await writeFile(TOMB, "config/prefs", utf8.encode("x"));
    await registerTomb("prj_abc");
    expect(listTombs()).toEqual([PERSONAL_TOMB, "prj_abc"]);
    const raw = kvGet(TOMBS_REGISTRY_KEY) ?? "";
    expect(raw).toContain(PERSONAL_TOMB);
    expect(raw).toContain("prj_abc");
    expect(raw).not.toContain("config");
    await unregisterTomb("prj_abc");
    expect(listTombs()).toEqual([PERSONAL_TOMB]);
  });
});

describe("vfs verbatim sealed files (the vault body)", () => {
  it("stores caller-sealed bytes unchanged and reads them back without a key", async () => {
    const { vaultKey } = await mintVaultKey();
    const blob = await sealJson(vaultKey, { v: 1, items: [], rev: 7 });
    unlockTomb(TOMB, vaultKey);
    await writeSealedFile(TOMB, BODY_PATH, blob);
    // Byte-identical to what a legacy flat key would have held.
    expect(kvGet(tombFileKey(TOMB, BODY_PATH))).toBe(JSON.stringify(blob));

    lockAllTombs();
    const back = readSealedFile(TOMB, BODY_PATH);
    expect(back).toEqual(blob);
    await expect(listDir(TOMB, "")).rejects.toMatchObject({ code: "locked" });
  });

  it("records a pre-unlock-moved body in the index on unlock", async () => {
    const { vaultKey } = await mintVaultKey();
    const blob = await sealJson(vaultKey, { v: 1, items: [], rev: 1 });
    // Phase B moved the body with no key: raw copy, no index entry.
    kvSet(tombFileKey(TOMB, BODY_PATH), JSON.stringify(blob));
    unlockTomb(TOMB, vaultKey);
    await ensureIndexed(TOMB, BODY_PATH);
    expect(await listDir(TOMB, "")).toEqual([BODY_PATH]);
  });
});

describe("vfs memory fallback", () => {
  it("works without OPFS and says so", async () => {
    await kvHydrate([]);
    // The test runner has no navigator.storage — the fallback is what every
    // write above already rode on.
    expect(kvDurability()).toBe("memory");
    await unlockedTomb();
    await writeFile(TOMB, "drops/one", utf8.encode("drop"));
    expect(utf8decode.decode(await readFile(TOMB, "drops/one"))).toBe("drop");
  });
});
