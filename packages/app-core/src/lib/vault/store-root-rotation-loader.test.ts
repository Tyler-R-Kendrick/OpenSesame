import { createVault } from "@opensesame/vault-core";
import { afterEach, expect, it, vi } from "vitest";
import {
  assertAuthenticationSession,
  markDecoySession,
} from "../decoy-session.js";
import { vfsSeams } from "../vfs.js";
import {
  recoverPreparedRoot,
  rotateRootDataset,
} from "./store-root-rotation-loader.js";

afterEach(() => {
  markDecoySession(false);
  vi.restoreAllMocks();
});

it.each([false, true])(
  "wipes a replacement key and avoids storage when loading crosses a successor realm (synthetic=%s)",
  async (synthetic) => {
    markDecoySession(false);
    const { header, rawVaultKey } = await createVault("Loader owner password");
    const realm = assertAuthenticationSession();
    const read = vi.spyOn(vfsSeams, "readRaw");
    const write = vi.spyOn(vfsSeams, "writeRaw");
    const pending = rotateRootDataset(
      Promise.resolve(),
      "loader-owner",
      null,
      null,
      rawVaultKey,
      header,
      () => assertAuthenticationSession(realm),
    );
    // The real module loader yields even when its module is already cached.
    markDecoySession(synthetic, "loader-owner");
    await expect(pending).rejects.toThrow("authenticate again");
    expect(rawVaultKey.every((byte) => byte === 0)).toBe(true);
    expect(read).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  },
);

it.each([false, true])(
  "does not recover or read a header when loading crosses a successor realm (synthetic=%s)",
  async (synthetic) => {
    markDecoySession(false);
    const realm = assertAuthenticationSession();
    const read = vi.spyOn(vfsSeams, "readRaw");
    const write = vi.spyOn(vfsSeams, "writeRaw");
    const pending = recoverPreparedRoot("loader-owner", null, () =>
      assertAuthenticationSession(realm),
    );
    markDecoySession(synthetic, "loader-owner");
    await expect(pending).rejects.toThrow("authenticate again");
    expect(read).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  },
);
