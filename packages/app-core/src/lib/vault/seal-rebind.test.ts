import {
  mintVaultKey,
  openJson,
  sealJson,
  vaultSealBinding,
} from "@opensesame/vault-core";
import { beforeEach, describe, expect, it } from "vitest";
import { kvDelete, kvGet } from "../kv.js";
import {
  BODY_PATH,
  INDEX_PATH,
  PERSONAL_TOMB,
  SEAL_BOUND_MARKER_PATH,
  lockAllTombs,
  readPlaintextFile,
  tombFileKey,
  unlockTomb,
  vfsFlush,
  vfsSeams,
} from "../vfs.js";
import { rebindTombSeals } from "./seal-rebind.js";

describe("seal rebind", () => {
  beforeEach(async () => {
    await vfsFlush();
    lockAllTombs();
    kvDelete(tombFileKey(PERSONAL_TOMB, BODY_PATH));
    kvDelete(tombFileKey(PERSONAL_TOMB, INDEX_PATH));
    kvDelete(tombFileKey(PERSONAL_TOMB, SEAL_BOUND_MARKER_PATH));
  });

  it("rewrites unbound seals and then requires the path binding", async () => {
    const { vaultKey } = await mintVaultKey();
    unlockTomb(PERSONAL_TOMB, vaultKey);
    const unbound = await sealJson(vaultKey, {
      v: 1,
      items: [],
      folders: [],
      rev: 1,
    });
    await vfsSeams.writeRaw(
      tombFileKey(PERSONAL_TOMB, BODY_PATH),
      JSON.stringify(unbound),
    );
    await rebindTombSeals(PERSONAL_TOMB, vaultKey);
    expect(readPlaintextFile(PERSONAL_TOMB, SEAL_BOUND_MARKER_PATH)).toBe("1");
    const raw = kvGet(tombFileKey(PERSONAL_TOMB, BODY_PATH));
    if (!raw) throw new Error("missing body");
    const blob = JSON.parse(raw);
    await expect(
      openJson(vaultKey, unbound, vaultSealBinding(PERSONAL_TOMB, BODY_PATH)),
    ).rejects.toThrow(/authentication tag/);
    await expect(
      openJson(vaultKey, blob, vaultSealBinding(PERSONAL_TOMB, BODY_PATH)),
    ).resolves.toMatchObject({ v: 1, rev: 1 });
  });
});
