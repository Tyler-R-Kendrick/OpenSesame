import { mintVaultKey } from "@opensesame/vault-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { kvDelete, kvGet, kvSeams, kvSet } from "../kv.js";
import {
  BODY_PATH,
  INDEX_PATH,
  PERSONAL_TOMB,
  SEAL_BOUND_MARKER_PATH,
  listDir,
  lockAllTombs,
  tombFileKey,
  unlockTomb,
  vfsFlush,
  writeFile,
} from "../vfs.js";
import { rebindTombSeals } from "./seal-rebind.js";

const hydrateDefault = kvSeams.kvHydrate;

describe("seal rebind keeps the sealed index across a reload", () => {
  beforeEach(async () => {
    await vfsFlush();
    lockAllTombs();
    for (const path of [BODY_PATH, INDEX_PATH, SEAL_BOUND_MARKER_PATH])
      kvDelete(tombFileKey(PERSONAL_TOMB, path));
  });

  afterEach(() => {
    kvSeams.kvHydrate = hydrateDefault;
  });

  it("lists a file written before the first unlock after sealing", async () => {
    const { vaultKey } = await mintVaultKey();
    unlockTomb(PERSONAL_TOMB, vaultKey);
    await writeFile(
      PERSONAL_TOMB,
      "config/kept",
      new TextEncoder().encode("x"),
    );
    await vfsFlush();
    // A reload: the files are on disk, and memory holds none of them until
    // something hydrates them.
    const disk = new Map<string, string>();
    for (const path of [INDEX_PATH, "config/kept"]) {
      const key = tombFileKey(PERSONAL_TOMB, path);
      const raw = kvGet(key);
      if (raw) disk.set(key, raw);
      kvDelete(key);
    }
    kvSeams.kvHydrate = async (keys) => {
      for (const key of keys) {
        const raw = disk.get(key);
        if (raw) kvSet(key, raw);
      }
    };
    lockAllTombs();
    unlockTomb(PERSONAL_TOMB, vaultKey);
    await rebindTombSeals(PERSONAL_TOMB, vaultKey);
    expect(await listDir(PERSONAL_TOMB, "config")).toEqual(["config/kept"]);
  });
});
