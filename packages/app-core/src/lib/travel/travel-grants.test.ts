import { describe, expect, it } from "vitest";
import { kvFileName } from "../kv.js";
import { completeDeparture, packDeparture } from "./depart.js";
import { clearRemnants, findRemnants } from "./remnants.js";
import { completeReturn, openReturn } from "./return.js";
import {
  ACK,
  PRJ_TRIP,
  PRJ_WORK,
  depart,
  packedDevice,
  tombFile,
} from "./travel.test-support.js";

const CONSENTS = kvFileName("site-broker.consents.v1");
const POLICY = kvFileName("site-broker.policy.v1");
const GRANTED = JSON.stringify({
  consents: [
    { origin: "https://a.example", scopes: ["openid"] },
    { origin: "https://b.example", scopes: ["openid"] },
  ],
});

async function opened(
  origin: ReturnType<typeof packedDevice>,
  pkg: {
    bundleJson: string;
    returnCode: string;
  },
) {
  const result = await openReturn(origin.deps, {
    bundleJson: pkg.bundleJson,
    returnCode: pkg.returnCode,
  });
  if (!result.ok) throw new Error(result.code);
  return result.opened;
}

describe("site grants on the way home", () => {
  it("are shown in the preview and left out unless asked for", async () => {
    const origin = packedDevice();
    origin.files.set(CONSENTS, GRANTED);
    origin.files.set(POLICY, JSON.stringify({ rules: [{ origin: "x" }] }));
    const { pkg } = await depart(origin, [PRJ_TRIP]);
    expect(origin.files.has(CONSENTS)).toBe(false);

    const back = await opened(origin, pkg);
    const personal = back.preview.vaults.find((v) => v.id === "personal");
    expect(personal?.grants).toEqual({
      sites: ["https://a.example", "https://b.example"],
      rules: 1,
    });

    const done = await completeReturn(origin.deps, back);
    if (!done.ok) throw new Error(done.code);
    expect(done.receipt.restored).toContain("personal");
    expect(done.receipt.grantsRestored).toEqual([]);
    expect(origin.files.has(CONSENTS)).toBe(false);
    expect(origin.files.has(POLICY)).toBe(false);
    expect(origin.files.has(tombFile("personal", "body"))).toBe(true);
  });

  it("come back when the person asks for them", async () => {
    const origin = packedDevice();
    origin.files.set(CONSENTS, GRANTED);
    const { pkg } = await depart(origin, [PRJ_TRIP]);
    const done = await completeReturn(origin.deps, await opened(origin, pkg), {
      grants: true,
    });
    if (!done.ok) throw new Error(done.code);
    expect(done.receipt.grantsRestored).toEqual(["personal"]);
    expect(origin.files.get(CONSENTS)).toBe(GRANTED);
  });

  it("never clear the grants the device already holds", async () => {
    const origin = packedDevice();
    const { pkg } = await depart(origin, [PRJ_TRIP]);
    // Granted on this device while the vault was away.
    origin.files.set(CONSENTS, GRANTED);
    const done = await completeReturn(origin.deps, await opened(origin, pkg));
    if (!done.ok) throw new Error(done.code);
    expect(origin.files.get(CONSENTS)).toBe(GRANTED);
  });
});

describe("a departure cut short, without its package", () => {
  it("is finished by the bundle's return when only the header stayed", async () => {
    const origin = packedDevice();
    const before = new Map(origin.files);
    const packed = await packDeparture(origin.deps, { safe: [PRJ_TRIP] });
    if (!packed.ok) throw new Error(packed.code);
    const header = tombFile(PRJ_WORK, "header");
    origin.stuck.add(header);
    await completeDeparture(origin.deps, packed.pkg, ACK);
    origin.stuck.clear();
    // The package is gone (a reload); the bundle and code are not.
    const back = await opened(origin, packed.pkg);
    const work = back.preview.vaults.find((v) => v.id === PRJ_WORK);
    expect(work?.status).toBe("comes_home");
    const done = await completeReturn(origin.deps, back);
    if (!done.ok) throw new Error(done.code);
    expect(done.receipt.restored).toContain(PRJ_WORK);
    expect(origin.files.get(tombFile(PRJ_WORK, "body"))).toBe(
      before.get(tombFile(PRJ_WORK, "body")),
    );
  });

  it("leaves headerless files that can be found and cleared", async () => {
    const origin = packedDevice();
    const packed = await packDeparture(origin.deps, { safe: [PRJ_TRIP] });
    if (!packed.ok) throw new Error(packed.code);
    const body = tombFile(PRJ_WORK, "body");
    origin.stuck.add(body);
    await completeDeparture(origin.deps, packed.pkg, ACK);
    origin.stuck.clear();

    expect(await findRemnants(origin.deps)).toEqual([
      { id: PRJ_WORK, files: [body] },
    ]);
    origin.duress = true;
    expect(await clearRemnants(origin.deps)).toEqual({
      ok: false,
      code: "duress_active",
    });
    origin.duress = false;
    expect(await clearRemnants(origin.deps)).toEqual({
      ok: true,
      cleared: [PRJ_WORK],
      leftovers: [],
    });
    expect(origin.files.has(body)).toBe(false);
    expect(origin.tombs.has(PRJ_WORK)).toBe(false);
    expect(await findRemnants(origin.deps)).toEqual([]);
  });

  it("never counts a sealed vault or a session tomb as a remnant", async () => {
    const origin = packedDevice();
    origin.tombs.add("guest");
    origin.files.set(tombFile("guest", "body"), "{}");
    expect(await findRemnants(origin.deps)).toEqual([]);
  });
});
