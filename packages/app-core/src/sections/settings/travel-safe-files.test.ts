import { describe, expect, it } from "vitest";
import {
  TRAVEL_SAFE_FILE,
  type TravelSafePorts,
  parseTravelSafe,
  travelSafeFiles,
  travelSafeText,
} from "./travel-safe-files.js";

type Stored = { safe: ReadonlySet<string>; writes: number };

function ports(overrides: Partial<TravelSafePorts> = {}) {
  const stored: Stored = {
    safe: new Set(["prj_a"]),
    writes: 0,
  };
  const base: TravelSafePorts = {
    owner: () => true,
    vaultIds: () => ["personal", "prj_a", "prj_b"],
    read: (present) =>
      new Set([...stored.safe].filter((id) => present.includes(id))),
    write: async (safe) => {
      stored.safe = safe;
      stored.writes += 1;
    },
    held: () => false,
    durable: () => true,
  };
  return { stored, provider: travelSafeFiles({ ...base, ...overrides }) };
}

describe("travel's safe list as a file (ADR 0134; ADR 0143)", () => {
  it("lists one writable file to the owner and nothing to anyone else", () => {
    expect(ports().provider.list()).toEqual([
      {
        path: TRAVEL_SAFE_FILE,
        language: "json",
        readOnly: false,
        removable: false,
      },
    ]);
    expect(ports({ owner: () => false }).provider.list()).toEqual([]);
  });

  it("reads vault ids and nothing else", async () => {
    const { provider } = ports();
    const text = await provider.read(TRAVEL_SAFE_FILE);
    expect(JSON.parse(text)).toEqual({ safe: ["prj_a"] });
    expect(Object.keys(JSON.parse(text))).toEqual(["safe"]);
  });

  it("drops a mark whose vault has left, as the sheet's read does", async () => {
    const { provider } = ports({ vaultIds: () => ["personal"] });
    expect(JSON.parse(await provider.read(TRAVEL_SAFE_FILE))).toEqual({
      safe: [],
    });
  });

  it("writes through the sheet's write, sorted, and reports the file as stored", async () => {
    const { provider, stored } = ports();
    const outcome = await provider.write(
      TRAVEL_SAFE_FILE,
      '{"safe":["prj_b","personal","prj_b"]}',
    );
    expect(outcome).toEqual({
      ok: true,
      path: TRAVEL_SAFE_FILE,
      text: travelSafeText(new Set(["personal", "prj_b"])),
    });
    expect([...stored.safe]).toEqual(["prj_b", "personal"]);
    expect(stored.writes).toBe(1);
  });

  it("says when the browser keeps it for this session only", async () => {
    const { provider } = ports({ durable: () => false });
    const outcome = await provider.write(TRAVEL_SAFE_FILE, '{"safe":[]}');
    expect(outcome).toMatchObject({ ok: true, tone: "warn" });
  });

  it("refuses what the sheet could not write, and writes nothing", async () => {
    const { provider, stored } = ports();
    for (const text of [
      "not json",
      "[]",
      '{"safe":"personal"}',
      '{"safe":[1]}',
      '{"safe":["prj_gone"]}',
      '{"safe":["guest"]}',
      '{"safe":[],"note":"a vault name"}',
      "{}",
    ]) {
      expect(provider.check(TRAVEL_SAFE_FILE, text).ok).toBe(false);
      expect((await provider.write(TRAVEL_SAFE_FILE, text)).ok).toBe(false);
    }
    expect(stored.writes).toBe(0);
    expect([...stored.safe]).toEqual(["prj_a"]);
  });

  it("accepts a valid write at check, without writing", () => {
    const { provider, stored } = ports();
    expect(provider.check(TRAVEL_SAFE_FILE, '{"safe":["prj_b"]}')).toEqual({
      ok: true,
    });
    expect(stored.writes).toBe(0);
  });

  it("refuses while a duress response holds the device", async () => {
    const { provider, stored } = ports({ held: () => true });
    const outcome = await provider.write(TRAVEL_SAFE_FILE, '{"safe":[]}');
    expect(outcome.ok).toBe(false);
    expect(stored.writes).toBe(0);
  });

  it("answers as if absent when no owner is at the device", async () => {
    const { provider, stored } = ports({ owner: () => false });
    await expect(provider.read(TRAVEL_SAFE_FILE)).rejects.toThrow();
    expect(provider.check(TRAVEL_SAFE_FILE, '{"safe":[]}').ok).toBe(false);
    expect((await provider.write(TRAVEL_SAFE_FILE, '{"safe":[]}')).ok).toBe(
      false,
    );
    expect(stored.writes).toBe(0);
  });

  it("refuses another path and a removal", async () => {
    const { provider, stored } = ports();
    await expect(
      provider.read("settings/security/travel/x.json"),
    ).rejects.toThrow();
    expect(
      (await provider.write("settings/security/travel/x.json", '{"safe":[]}'))
        .ok,
    ).toBe(false);
    expect((await provider.remove(TRAVEL_SAFE_FILE)).ok).toBe(false);
    expect(stored.writes).toBe(0);
  });

  it("surfaces a write the browser would not keep as a refusal", async () => {
    const { provider } = ports({
      write: async () => {
        throw new Error("quota");
      },
    });
    const outcome = await provider.write(TRAVEL_SAFE_FILE, '{"safe":[]}');
    expect(outcome).toEqual({
      ok: false,
      message: "The browser would not keep it.",
    });
  });

  it("parses to a set of ids", () => {
    expect(parseTravelSafe('{"safe":["personal"]}', ["personal"])).toEqual({
      ok: true,
      safe: new Set(["personal"]),
    });
  });
});
