import fc from "fast-check";
import { expect, it } from "vitest";
import { VfsError } from "./vfs-errors.js";
import {
  assertRootGeneration,
  recordRootGeneration,
} from "./vfs-root-admission.js";

it("rejects every changed protected root binding while allowing body witnesses to advance", async () => {
  const key = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  fc.assert(
    fc.property(fc.uuid(), fc.uuid(), fc.uuid(), (vault, root, successor) => {
      fc.pre(root !== successor && vault !== successor);
      const tomb = `root-property-${root}`;
      const header = (vaultId: string, rootKeyId: string, bodyRev: number) =>
        JSON.stringify({
          v: 1,
          protection: { vaultId, rootKeyId },
          bodyRev,
        });
      recordRootGeneration(tomb, key, header(vault, root, 1));
      recordRootGeneration(`${tomb}-peer`, key, header(vault, root, 1));
      expect(() =>
        assertRootGeneration(tomb, key, header(vault, root, 2)),
      ).not.toThrow();
      expect(() =>
        assertRootGeneration(tomb, key, header(vault, successor, 2)),
      ).toThrow();
      expect(() =>
        assertRootGeneration(tomb, key, header(successor, root, 2)),
      ).toThrow();
      try {
        assertRootGeneration(tomb, key, null);
        throw new Error("An absent header regained authority");
      } catch (error) {
        expect(error).toBeInstanceOf(VfsError);
        expect(error).toMatchObject({ code: "locked" });
      }
      expect(() =>
        assertRootGeneration(`${tomb}-other`, key, header(vault, root, 2)),
      ).toThrow();
    }),
    { seed: 1731008, numRuns: 64 },
  );
});

it("keeps legacy authority tied to its original creation and unlock records", async () => {
  const key = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  const header = {
    v: 1,
    createdAt: "2026-10-06",
    wrap: { marker: "original" },
    unlocks: { pin: { marker: "original" } },
  };
  recordRootGeneration("legacy-property", key, JSON.stringify(header));
  expect(() =>
    assertRootGeneration(
      "legacy-property",
      key,
      JSON.stringify({ ...header, bodyRev: 8 }),
    ),
  ).not.toThrow();
  for (const next of [
    { ...header, createdAt: "2026-10-07" },
    { ...header, wrap: { marker: "replacement" } },
    { ...header, unlocks: { pin: { marker: "replacement" } } },
  ])
    expect(() =>
      assertRootGeneration("legacy-property", key, JSON.stringify(next)),
    ).toThrow();
  try {
    assertRootGeneration("legacy-property", key, "[]");
    throw new Error("A malformed header regained authority");
  } catch (error) {
    expect(error).toBeInstanceOf(VfsError);
    expect(error).toMatchObject({ code: "corrupt" });
  }
});
