import {
  mintVaultKey,
  openJson,
  sealJson,
  vaultSealBinding,
} from "@opensesame/vault-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  afterEach(() => {
    vi.restoreAllMocks();
  });
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
  it("withholds an old migration's sealed index and marker after another root admission", async () => {
    const original = await mintVaultKey();
    unlockTomb(PERSONAL_TOMB, original.vaultKey);
    let reached = () => {};
    const started = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let resume = () => {};
    const blocked = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const encrypt = crypto.subtle.encrypt.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, "encrypt").mockImplementationOnce(
      async (...args) => {
        const sealed = await encrypt(...args);
        reached();
        await blocked;
        return sealed;
      },
    );
    const pending = rebindTombSeals(PERSONAL_TOMB, original.vaultKey).then(
      () => null,
      (error: Error) => error,
    );
    await started;
    const next = await mintVaultKey();
    unlockTomb(PERSONAL_TOMB, next.vaultKey);
    resume();
    expect(await pending).toMatchObject({ code: "locked" });
    expect(kvGet(tombFileKey(PERSONAL_TOMB, INDEX_PATH))).toBeNull();
    expect(readPlaintextFile(PERSONAL_TOMB, SEAL_BOUND_MARKER_PATH)).toBeNull();
    original.rawVaultKey.fill(0);
    next.rawVaultKey.fill(0);
  });
  it("rejects a retained real key passed directly after a successor key is admitted", async () => {
    const original = await mintVaultKey();
    const next = await mintVaultKey();
    unlockTomb(PERSONAL_TOMB, next.vaultKey);
    await expect(
      rebindTombSeals(PERSONAL_TOMB, original.vaultKey),
    ).rejects.toMatchObject({ code: "locked" });
    expect(readPlaintextFile(PERSONAL_TOMB, SEAL_BOUND_MARKER_PATH)).toBeNull();
    original.rawVaultKey.fill(0);
    next.rawVaultKey.fill(0);
  });
});
