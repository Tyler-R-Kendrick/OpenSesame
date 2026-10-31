import { mintVaultKey } from "@opensesame/vault-core";
import { expect, it } from "vitest";
import { deferred, withFixture } from "./kv.entry-lifecycle.test-support.js";
import { kvFileName, kvGet } from "./kv.js";
import {
  INDEX_PATH,
  TOMBS_REGISTRY_KEY,
  listTombs,
  lockTomb,
  tombFileKey,
  unlockTomb,
  writeFile,
} from "./vfs.js";

it.each(["file", "index", "registry"] as const)(
  "a guarded write retains its original owner through the actual %s commit",
  (boundary) =>
    withFixture(async (root) => {
      const tomb = `guarded-commit-${crypto.randomUUID()}`;
      const path = "config/test-owned-write";
      const { vaultKey, rawVaultKey } = await mintVaultKey();
      rawVaultKey.fill(0);
      unlockTomb(tomb, vaultKey);
      const started = deferred();
      const resume = deferred();
      const storageKey =
        boundary === "registry"
          ? TOMBS_REGISTRY_KEY
          : tombFileKey(tomb, boundary === "index" ? INDEX_PATH : path);
      const target = kvFileName(storageKey);
      let live = true;
      root.hooks.write = async (name) => {
        if (name === target) {
          started.resolve();
          await resume.promise;
        }
      };
      const writing = writeFile(
        tomb,
        path,
        new TextEncoder().encode("synthetic fixture"),
        () => {
          if (!live) throw new Error("Original owner ended");
        },
      );
      const refused = expect(writing).rejects.toThrow(/Original owner ended/);
      await started.promise;
      const physical = root.files.get(target);
      const memory = kvGet(storageKey);
      try {
        live = false;
        lockTomb(tomb);
        resume.resolve();
        await refused;
        expect(root.files.get(target)).toBe(physical);
        expect(kvGet(storageKey)).toBe(memory);
        expect(listTombs()).not.toContain(tomb);
      } finally {
        resume.resolve();
        await Promise.allSettled([writing]);
        lockTomb(tomb);
      }
    }),
);
