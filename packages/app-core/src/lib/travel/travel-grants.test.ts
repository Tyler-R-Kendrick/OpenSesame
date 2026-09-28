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
const consent = (origin: string) => ({
  origin,
  scopes: ["openid"],
  approvedAt: "2026-09-01T00:00:00.000Z",
  lastUsedAt: "2026-09-01T00:00:00.000Z",
});
const GRANTED = JSON.stringify({
  consents: [consent("https://a.example"), consent("https://b.example")],
});
const POLICY_BOTH = JSON.stringify({
  rules: [
    { domain: "allowed.example", effect: "whitelist" },
    { domain: "evil.example", effect: "blacklist" },
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
  it("names what would be let in, and keeps blocks without the tick", async () => {
    const origin = packedDevice();
    origin.files.set(CONSENTS, GRANTED);
    origin.files.set(POLICY, POLICY_BOTH);
    const { pkg } = await depart(origin, [PRJ_TRIP]);
    expect(origin.files.has(CONSENTS)).toBe(false);

    const back = await opened(origin, pkg);
    const personal = back.preview.vaults.find((v) => v.id === "personal");
    expect(personal?.grants).toEqual({
      sites: ["allowed.example", "https://a.example", "https://b.example"],
    });

    const done = await completeReturn(origin.deps, back);
    if (!done.ok) throw new Error(done.code);
    expect(done.receipt.restored).toContain("personal");
    expect(done.receipt.grantsRestored).toEqual([]);
    expect(origin.files.has(CONSENTS)).toBe(false);
    // The block comes home; the allow does not.
    expect(JSON.parse(origin.files.get(POLICY) ?? "{}")).toEqual({
      rules: [{ domain: "evil.example", effect: "blacklist" }],
    });
    expect(origin.files.has(tombFile("personal", "body"))).toBe(true);
  });

  it("come back whole when the person asks for them", async () => {
    const origin = packedDevice();
    origin.files.set(CONSENTS, GRANTED);
    origin.files.set(POLICY, POLICY_BOTH);
    const { pkg } = await depart(origin, [PRJ_TRIP]);
    const done = await completeReturn(origin.deps, await opened(origin, pkg), {
      grants: true,
    });
    if (!done.ok) throw new Error(done.code);
    expect(done.receipt.grantsRestored).toEqual(["personal"]);
    expect(origin.files.get(CONSENTS)).toBe(GRANTED);
    expect(JSON.parse(origin.files.get(POLICY) ?? "{}").rules).toHaveLength(2);
  });

  it("leave no site let in without asking, keeping every block on the device", async () => {
    const origin = packedDevice();
    const { pkg } = await depart(origin, [PRJ_TRIP]);
    // Left on the device while the vault was away (or by a departure cut
    // short): a consent and a block.
    origin.files.set(CONSENTS, GRANTED);
    origin.files.set(
      POLICY,
      JSON.stringify({
        rules: [{ domain: "bad.example", effect: "blacklist" }],
      }),
    );
    const done = await completeReturn(origin.deps, await opened(origin, pkg));
    if (!done.ok) throw new Error(done.code);
    expect(origin.files.has(CONSENTS)).toBe(false);
    expect(JSON.parse(origin.files.get(POLICY) ?? "{}")).toEqual({
      rules: [{ domain: "bad.example", effect: "blacklist" }],
    });
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

  it("never counts a sealed, legacy, unsealed or session vault as a remnant", async () => {
    const origin = packedDevice();
    origin.tombs.add("guest");
    origin.files.set(tombFile("guest", "body"), "{}");
    // A project still under the pre-tomb keys: a tomb file, no tomb header.
    origin.tombs.add("prj_legacy");
    origin.files.set(tombFile("prj_legacy", "config/prefs"), "{}");
    origin.files.set(kvFileName("project.prj_legacy.vault.header.v1"), "{}");
    // A project registered but never sealed, with only a plaintext record.
    origin.tombs.add("prj_draft");
    origin.files.set(kvFileName("project.prj_draft.vault.attempts.v1"), "{}");
    expect(await findRemnants(origin.deps)).toEqual([]);
  });

  it("a return cut short leaves its files where they can be found", async () => {
    const origin = packedDevice();
    const { pkg } = await depart(origin, [PRJ_TRIP]);
    const back = await opened(origin, pkg);
    // The header write is refused: everything else of Work has landed.
    const header = tombFile(PRJ_WORK, "header");
    const write = origin.deps.storage.write;
    origin.deps.storage.write = async (file, text) => {
      if (file === header) throw new Error("QuotaExceededError");
      return write(file, text);
    };
    await expect(completeReturn(origin.deps, back)).rejects.toThrow();
    origin.deps.storage.write = write;
    // Personal came home first; Work stopped short of its header.
    expect((await findRemnants(origin.deps)).map((r) => r.id)).toEqual([
      PRJ_WORK,
    ]);
  });
});
