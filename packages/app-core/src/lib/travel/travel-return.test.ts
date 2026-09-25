import { describe, expect, it } from "vitest";
import { kvFileName } from "../kv.js";
import {
  TravelBundleError,
  openTravelBundle,
  sealTravelBundle,
} from "./bundle-format.js";
import { formatReturnCode, mintReturnSecret } from "./return-code.js";
import { completeReturn, openReturn } from "./return.js";
import { vaultNamespace } from "./storage.js";
import {
  PRJ_TRIP,
  PRJ_WORK,
  depart,
  packedDevice,
  putVault,
  tombFile,
} from "./travel.test-support.js";

describe("return", () => {
  it("puts every file back and registers the tombs", async () => {
    const origin = packedDevice();
    const before = new Map(origin.files);
    const { pkg } = await depart(origin, [PRJ_TRIP]);
    const opened = await openReturn(origin.deps, {
      bundleJson: pkg.bundleJson,
      returnCode: pkg.returnCode,
    });
    if (!opened.ok) throw new Error(opened.code);
    expect(opened.opened.preview.vaults).toEqual([
      {
        id: "personal",
        kind: "personal",
        name: null,
        files: 5,
        status: "comes_home",
      },
      {
        id: PRJ_WORK,
        kind: "project",
        name: "Work",
        files: 5,
        status: "comes_home",
      },
    ]);
    expect(await completeReturn(origin.deps, opened.opened)).toEqual({
      ok: true,
      receipt: {
        restored: ["personal", PRJ_WORK],
        alreadyHome: [],
        occupied: [],
        writtenFiles: 10,
      },
    });
    expect(new Map(origin.files)).toEqual(before);
    expect([...origin.tombs].sort()).toEqual(
      ["personal", PRJ_TRIP, PRJ_WORK].sort(),
    );
    expect(origin.welcomed).toEqual([["personal", PRJ_WORK]]);

    const again = await openReturn(origin.deps, {
      bundleJson: pkg.bundleJson,
      returnCode: pkg.returnCode,
    });
    if (!again.ok) throw new Error(again.code);
    expect(again.opened.preview.vaults.map((v) => v.status)).toEqual([
      "already_home",
      "already_home",
    ]);

    // Work is opened and edited after it came home. The same bundle, used
    // again, must not put the older copy back.
    const edited = '{"ivB64":"after","ctB64":"after"}';
    origin.files.set(tombFile(PRJ_WORK, "body"), edited);
    const stale = await openReturn(origin.deps, {
      bundleJson: pkg.bundleJson,
      returnCode: pkg.returnCode,
    });
    if (!stale.ok) throw new Error(stale.code);
    expect(stale.opened.preview.vaults.map((v) => v.status)).toEqual([
      "already_home",
      "occupied",
    ]);
    const done = await completeReturn(origin.deps, stale.opened);
    expect(done).toMatchObject({ ok: true, receipt: { restored: [] } });
    expect(origin.files.get(tombFile(PRJ_WORK, "body"))).toBe(edited);
  });

  it("finishes a return that was cut short", async () => {
    const origin = packedDevice();
    const before = new Map(origin.files);
    const { pkg } = await depart(origin, [PRJ_TRIP]);
    const opened = await openReturn(origin.deps, {
      bundleJson: pkg.bundleJson,
      returnCode: pkg.returnCode,
    });
    if (!opened.ok) throw new Error(opened.code);
    let writes = 0;
    const flaky = {
      ...origin.deps,
      storage: {
        ...origin.deps.storage,
        write: async (file: string, text: string) => {
          writes += 1;
          if (writes === 5) throw new Error("quota exceeded");
          await origin.deps.storage.write(file, text);
        },
      },
    };
    await expect(completeReturn(flaky, opened.opened)).rejects.toThrow(
      "quota exceeded",
    );
    const retry = await completeReturn(origin.deps, opened.opened);
    expect(retry).toMatchObject({
      ok: true,
      receipt: { restored: ["personal", PRJ_WORK], occupied: [] },
    });
    expect(new Map(origin.files)).toEqual(before);
  });

  it("reads the device again at completion, not the preview", async () => {
    const origin = packedDevice();
    const { pkg } = await depart(origin, [PRJ_TRIP]);
    const opened = await openReturn(origin.deps, {
      bundleJson: pkg.bundleJson,
      returnCode: pkg.returnCode,
    });
    if (!opened.ok) throw new Error(opened.code);
    // A vault is sealed under that id while the preview is on screen.
    putVault(origin, PRJ_WORK, '{"ivB64":"new","ctB64":"new"}');
    origin.duress = true;
    expect(await completeReturn(origin.deps, opened.opened)).toEqual({
      ok: false,
      code: "duress_active",
    });
    origin.duress = false;
    const done = await completeReturn(origin.deps, opened.opened);
    expect(done).toMatchObject({
      ok: true,
      receipt: { restored: ["personal"], occupied: [PRJ_WORK] },
    });
    expect(origin.files.get(tombFile(PRJ_WORK, "body"))).toContain("new");
  });

  it("leaves a vault sealed on the road alone", async () => {
    const origin = packedDevice();
    const { pkg } = await depart(origin, [PRJ_TRIP]);
    putVault(origin, "personal", '{"ivB64":"road","ctB64":"road"}');
    origin.files.set(
      tombFile("personal", "header"),
      '{"v":1,"createdAt":"road"}',
    );
    const opened = await openReturn(origin.deps, {
      bundleJson: pkg.bundleJson,
      returnCode: pkg.returnCode,
    });
    if (!opened.ok) throw new Error(opened.code);
    const done = await completeReturn(origin.deps, opened.opened);
    if (!done.ok) throw new Error(done.code);
    expect(done.receipt.occupied).toEqual(["personal"]);
    expect(done.receipt.restored).toEqual([PRJ_WORK]);
    expect(origin.files.get(tombFile("personal", "body"))).toContain("road");
  });

  it("tells a wrong code from a typo, and a stranger's file from a vault's", async () => {
    const origin = packedDevice();
    const { pkg } = await depart(origin, [PRJ_TRIP]);
    const wrong = await formatReturnCode(mintReturnSecret());
    expect(
      await openReturn(origin.deps, {
        bundleJson: pkg.bundleJson,
        returnCode: wrong,
      }),
    ).toMatchObject({ ok: false, code: "code_mismatch" });
    expect(
      await openReturn(origin.deps, {
        bundleJson: pkg.bundleJson,
        returnCode: "ABCD",
      }),
    ).toMatchObject({ ok: false, code: "code_malformed" });
    expect(
      await openReturn(origin.deps, {
        bundleJson: "{}",
        returnCode: pkg.returnCode,
      }),
    ).toMatchObject({ ok: false, code: "bundle_malformed" });

    // A bundle someone else wrote, carrying the device's guest switch.
    const secret = mintReturnSecret();
    const hostile = await sealTravelBundle(
      {
        v: 1,
        bundleId: "trv_hostile",
        departedAt: "2026-09-24T00:00:00.000Z",
        vaults: [
          {
            id: PRJ_WORK,
            kind: "project",
            name: null,
            files: [{ file: kvFileName("guest-access.v1"), text: "{}" }],
          },
        ],
      },
      secret,
    );
    const refused = await openReturn(origin.deps, {
      bundleJson: hostile,
      returnCode: await formatReturnCode(secret),
    });
    expect(refused).toMatchObject({ ok: false, code: "foreign_file" });
    expect(origin.files.get(kvFileName("guest-access.v1"))).toBe(
      '{"allow":true}',
    );
    await expect(
      openTravelBundle(hostile, secret, vaultNamespace([])),
    ).rejects.toBeInstanceOf(TravelBundleError);
  });

  it("refuses a bundle vault with no header, rather than wiping one here", async () => {
    const origin = packedDevice();
    const secret = mintReturnSecret();
    const headless = await sealTravelBundle(
      {
        v: 1,
        bundleId: "trv_headless",
        departedAt: "2026-09-24T00:00:00.000Z",
        vaults: [
          {
            id: PRJ_WORK,
            kind: "project",
            name: null,
            files: [{ file: tombFile(PRJ_WORK, "body"), text: "{}" }],
          },
        ],
      },
      secret,
    );
    expect(
      await openReturn(origin.deps, {
        bundleJson: headless,
        returnCode: await formatReturnCode(secret),
      }),
    ).toMatchObject({ ok: false, code: "bundle_malformed" });
    expect(origin.files.get(tombFile(PRJ_WORK, "header"))).not.toBeUndefined();
  });
});
