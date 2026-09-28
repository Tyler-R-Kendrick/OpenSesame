import { describe, expect, it } from "vitest";
import { completeDeparture, packDeparture } from "./depart.js";
import { completeReturn, openReturn } from "./return.js";
import {
  ACK,
  PRJ_TRIP,
  PRJ_WORK,
  depart,
  packedDevice,
  putVault,
  tombFile,
  vault,
} from "./travel.test-support.js";

async function pack(origin: ReturnType<typeof packedDevice>) {
  const packed = await packDeparture(origin.deps, { safe: [PRJ_TRIP] });
  if (!packed.ok) throw new Error(packed.code);
  return packed.pkg;
}

describe("departure, checked again at removal", () => {
  it("will not remove a vault that became the open vault after packing", async () => {
    const origin = packedDevice();
    const pkg = await pack(origin);
    // The person switched to Work while the packed view was on screen.
    origin.vaults = origin.vaults.map((entry) =>
      entry.id === PRJ_WORK
        ? { ...entry, state: "open" }
        : entry.id === PRJ_TRIP
          ? { ...entry, state: "locked" }
          : entry,
    );
    const files = origin.files.size;
    expect(await completeDeparture(origin.deps, pkg, ACK)).toEqual({
      ok: false,
      code: "open_vault_departs",
    });
    expect(origin.files.size).toBe(files);
    expect(origin.tombs.has(PRJ_WORK)).toBe(true);
  });

  it("will not leave a vault sealed after packing behind unannounced", async () => {
    const origin = packedDevice();
    const pkg = await pack(origin);
    putVault(origin, "prj_new");
    origin.vaults = [...origin.vaults, vault("prj_new")];
    expect(await completeDeparture(origin.deps, pkg, ACK)).toEqual({
      ok: false,
      code: "changed_since_packed",
    });
    expect(origin.tombs.has(PRJ_WORK)).toBe(true);
  });
});

describe("a removal cut short", () => {
  it("reports what stayed, then finishes with the same package", async () => {
    const origin = packedDevice();
    const pkg = await pack(origin);
    const stuck = tombFile(PRJ_WORK, "body");
    origin.stuck.add(stuck);

    const first = await completeDeparture(origin.deps, pkg, ACK);
    if (!first.ok) throw new Error(first.code);
    expect(first.receipt.completion).toBe("incomplete");
    expect(first.receipt.leftovers).toEqual([stuck]);
    // Every other file went, the header first among them.
    expect(origin.files.has(tombFile(PRJ_WORK, "header"))).toBe(false);
    expect(origin.files.has(tombFile("personal", "body"))).toBe(false);

    origin.stuck.clear();
    const second = await completeDeparture(origin.deps, pkg, ACK);
    if (!second.ok) throw new Error(second.code);
    expect(second.receipt).toMatchObject({
      completion: "applied_local",
      leftovers: [],
      removedFiles: 1,
    });
    expect(origin.files.has(stuck)).toBe(false);
  });

  it("will not finish over a leftover that changed since packing", async () => {
    const origin = packedDevice();
    const pkg = await pack(origin);
    const stuck = tombFile(PRJ_WORK, "body");
    origin.stuck.add(stuck);
    await completeDeparture(origin.deps, pkg, ACK);
    origin.stuck.clear();
    origin.files.set(stuck, '{"ivB64":"x","ctB64":"x"}');
    expect(await completeDeparture(origin.deps, pkg, ACK)).toEqual({
      ok: false,
      code: "changed_since_packed",
    });
    expect(origin.files.has(stuck)).toBe(true);
  });
});

describe("return", () => {
  it("hands each vault's carried name back to the list", async () => {
    const origin = packedDevice();
    const { pkg } = await depart(origin, [PRJ_TRIP]);
    const opened = await openReturn(origin.deps, {
      bundleJson: pkg.bundleJson,
      returnCode: pkg.returnCode,
    });
    if (!opened.ok) throw new Error(opened.code);
    await completeReturn(origin.deps, opened.opened);
    expect(origin.welcomedNames.get(PRJ_WORK)).toBe("Work");
    expect(origin.welcomedNames.get("personal")).toBeNull();
  });
});
