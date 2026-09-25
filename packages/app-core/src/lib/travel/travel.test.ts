import { describe, expect, it } from "vitest";
import { kvFileName } from "../kv.js";
import { openTravelBundle } from "./bundle-format.js";
import { completeDeparture, packDeparture } from "./depart.js";
import { planTravel } from "./plan.js";
import {
  formatReturnCode,
  mintReturnSecret,
  parseReturnCode,
} from "./return-code.js";
import { filesOfVault, tombOwning, vaultNamespace } from "./storage.js";
import {
  ACK,
  PRJ_TRIP,
  PRJ_WORK,
  depart,
  packedDevice,
  tombFile,
  vault,
} from "./travel.test-support.js";

describe("the return code", () => {
  it("round-trips, forgiving case, dashes and look-alike digits", async () => {
    const secret = mintReturnSecret();
    const code = await formatReturnCode(secret);
    expect(code).toMatch(/^([A-Z2-7]{4}-){7}[A-Z2-7]{4}$/);
    const sloppy = code
      .toLowerCase()
      .replace(/-/g, " ")
      .replace(/o/g, "0")
      .replace(/i/g, "1");
    expect((await parseReturnCode(sloppy)).bytes).toEqual(secret.bytes);
  });

  it("names a typo as a typo, not as a wrong code", async () => {
    const code = await formatReturnCode(mintReturnSecret());
    const flipped = `${code[0] === "A" ? "B" : "A"}${code.slice(1)}`;
    await expect(parseReturnCode(flipped)).rejects.toMatchObject({
      code: "code_malformed",
    });
    await expect(parseReturnCode(code.slice(0, -1))).rejects.toMatchObject({
      code: "code_malformed",
    });
  });
});

describe("planning (safe for travel)", () => {
  const vaults = [
    vault("personal", "open"),
    vault(PRJ_WORK),
    vault(PRJ_TRIP, "empty"),
    { ...vault("guest", "empty"), kind: "guest" as const },
  ];

  it("sends home every sealed vault not marked safe", () => {
    expect(planTravel({ vaults, safe: ["personal"] })).toEqual({
      ok: true,
      plan: { staying: ["personal"], departing: [PRJ_WORK] },
    });
  });

  it("refuses to take away the open vault, or nothing, or a stranger", () => {
    expect(planTravel({ vaults, safe: [PRJ_WORK] })).toMatchObject({
      ok: false,
      code: "open_vault_departs",
      ids: ["personal"],
    });
    expect(planTravel({ vaults, safe: ["personal", PRJ_WORK] })).toMatchObject({
      ok: false,
      code: "nothing_departs",
    });
    expect(planTravel({ vaults, safe: ["guest"] })).toMatchObject({
      ok: false,
      code: "unknown_vault",
    });
  });
});

describe("which files are a vault's", () => {
  it("gives a file to the longest tomb name it starts with", () => {
    const nested = tombFile("personal_x", "body");
    expect(tombOwning(nested, ["personal", "personal_x"])).toBe("personal_x");
    expect(
      filesOfVault(
        "personal",
        [nested, tombFile("personal", "body")],
        ["personal", "personal_x"],
      ),
    ).toEqual([tombFile("personal", "body")]);
  });

  it("never lets a vault claim a device-wide record", () => {
    const owns = vaultNamespace(["personal"]);
    expect(owns("personal", kvFileName("vault.attempts.v1"))).toBe(true);
    expect(owns("personal", kvFileName("tombs.v1"))).toBe(false);
    expect(owns("personal", kvFileName("opensesame.duress.fence.v1"))).toBe(
      false,
    );
    expect(owns(PRJ_WORK, tombFile("personal", "header"))).toBe(false);
  });
});

describe("departure", () => {
  it("takes the vault off the device whole and says what is gone", async () => {
    const origin = packedDevice();
    const before = new Map(origin.files);
    const { pkg, receipt } = await depart(origin, [PRJ_TRIP]);

    expect(pkg.plan.departing).toEqual(["personal", PRJ_WORK]);
    expect(receipt).toMatchObject({
      departed: ["personal", PRJ_WORK],
      removedFiles: 10,
      leftovers: [],
      completion: "applied_local",
      assurance: "application_scoped_removal",
    });
    expect([...origin.files.keys()].sort()).toEqual(
      [
        tombFile(PRJ_TRIP, "header"),
        tombFile(PRJ_TRIP, "body"),
        tombFile(PRJ_TRIP, "config/prefs"),
        tombFile(PRJ_TRIP, "config/tree-collapsed"),
        kvFileName("guest-access.v1"),
      ].sort(),
    );
    expect([...origin.tombs]).toEqual([PRJ_TRIP]);
    expect(origin.vaults.map((v) => v.id)).toEqual([PRJ_TRIP, "guest"]);
    expect(origin.forgotten[0]).toHaveLength(10);
    // Everything that left is in the bundle, byte for byte.
    const opened = await openTravelBundle(
      pkg.bundleJson,
      await parseReturnCode(pkg.returnCode),
      vaultNamespace([PRJ_TRIP, "personal", PRJ_WORK]),
    );
    for (const carried of opened.vaults) {
      for (const entry of carried.files) {
        expect(before.get(entry.file)).toBe(entry.text);
      }
    }
    expect(opened.vaults.map((v) => v.name)).toEqual([null, "Work"]);
  });

  it("says nothing outside the seal about what left", async () => {
    const origin = packedDevice();
    const { pkg } = await depart(origin, [PRJ_TRIP]);
    expect(pkg.bundleJson).not.toContain("Work");
    expect(pkg.bundleJson).not.toContain(PRJ_WORK);
    expect(pkg.bundleJson).not.toContain("personal");
    expect(pkg.bundleFileName).toMatch(
      /^opensesame-[0-9a-f]{8}\.travel\.json$/,
    );
    expect(Object.keys(JSON.parse(pkg.bundleJson)).sort()).toEqual([
      "bundleId",
      "format",
      "sealed",
      "v",
    ]);
  });

  it("removes nothing until both halves are said to be elsewhere", async () => {
    const origin = packedDevice();
    const packed = await packDeparture(origin.deps, { safe: [PRJ_TRIP] });
    if (!packed.ok) throw new Error(packed.code);
    const count = origin.files.size;
    expect(
      await completeDeparture(origin.deps, packed.pkg, {
        bundleSaved: true,
        codeRecorded: false,
      }),
    ).toEqual({ ok: false, code: "not_acknowledged" });
    expect(origin.files.size).toBe(count);
  });

  it("will not remove a vault that changed after it was packed", async () => {
    const origin = packedDevice();
    const packed = await packDeparture(origin.deps, { safe: [PRJ_TRIP] });
    if (!packed.ok) throw new Error(packed.code);
    origin.files.set(tombFile(PRJ_WORK, "body"), '{"ivB64":"n","ctB64":"n"}');
    expect(await completeDeparture(origin.deps, packed.pkg, ACK)).toEqual({
      ok: false,
      code: "changed_since_packed",
    });
    expect(origin.tombs.has(PRJ_WORK)).toBe(true);
  });

  it("refuses while a vault still sits under the pre-tomb keys", async () => {
    const origin = packedDevice();
    origin.legacy = ["prj_legacy"];
    expect(await packDeparture(origin.deps, { safe: [PRJ_TRIP] })).toEqual({
      ok: false,
      code: "vault_needs_opening",
      ids: ["prj_legacy"],
    });
  });

  it("checks the gates again before removing anything", async () => {
    const origin = packedDevice();
    const packed = await packDeparture(origin.deps, { safe: [PRJ_TRIP] });
    if (!packed.ok) throw new Error(packed.code);
    origin.duress = true;
    expect(await completeDeparture(origin.deps, packed.pkg, ACK)).toEqual({
      ok: false,
      code: "duress_active",
    });
    expect(origin.tombs.has(PRJ_WORK)).toBe(true);
  });

  it("refuses under duress, to a guest, and where nothing is durable", async () => {
    const origin = packedDevice();
    origin.owner = false;
    expect(await packDeparture(origin.deps, { safe: [PRJ_TRIP] })).toEqual({
      ok: false,
      code: "owner_not_present",
      ids: [],
    });
    origin.owner = true;
    origin.duress = true;
    expect(await packDeparture(origin.deps, { safe: [PRJ_TRIP] })).toEqual({
      ok: false,
      code: "duress_active",
      ids: [],
    });
    origin.duress = false;
    origin.durable = false;
    expect(await packDeparture(origin.deps, { safe: [PRJ_TRIP] })).toEqual({
      ok: false,
      code: "storage_not_durable",
      ids: [],
    });
  });
});
