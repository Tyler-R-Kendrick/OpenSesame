import { beforeEach, describe, expect, it } from "vitest";
import { kvDelete, kvSet } from "../kv.js";
import {
  TRAVEL_SAFE_KEY,
  readSafeFlags,
  writeSafeFlags,
} from "./safe-flags.js";

describe("the vaults marked safe to carry (ADR 0143)", () => {
  beforeEach(() => kvDelete(TRAVEL_SAFE_KEY));

  it("starts with nothing marked", () => {
    expect(readSafeFlags(["personal", "prj_a"])).toEqual(new Set());
  });

  it("remembers the marks", async () => {
    await writeSafeFlags(new Set(["prj_b", "prj_a"]));
    expect(readSafeFlags(["personal", "prj_a", "prj_b"])).toEqual(
      new Set(["prj_a", "prj_b"]),
    );
  });

  it("drops a vault that is no longer on the device", async () => {
    await writeSafeFlags(new Set(["prj_a", "prj_gone"]));
    expect(readSafeFlags(["personal", "prj_a"])).toEqual(new Set(["prj_a"]));
  });

  it("reads a damaged record as nothing marked", () => {
    for (const raw of ["not json", '{"safe":"x"}', '{"safe":[1,null]}', "[]"]) {
      kvSet(TRAVEL_SAFE_KEY, raw);
      expect(readSafeFlags(["personal"])).toEqual(new Set());
    }
  });
});
