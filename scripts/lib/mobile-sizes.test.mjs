import { describe, expect, it } from "vitest";
import {
  PHONES,
  TABLETS,
} from "../../apps/pages/scripts/lib/mobile-contract.mjs";
import { sizesToWalk } from "../../apps/pages/scripts/lib/mobile-sizes.mjs";

describe("which sizes verify:mobile walks", () => {
  it("walks every size when nothing is named", () => {
    for (const unset of [undefined, "", " , "]) {
      expect(sizesToWalk(unset)).toEqual({ phones: PHONES, tablets: TABLETS });
    }
  });

  it("walks only the named sizes, phones and tablets alike", () => {
    const walked = sizesToWalk("390, landscape,tablet-portrait");
    expect(walked.phones.map((size) => size.name)).toEqual([
      "390",
      "landscape",
    ]);
    expect(walked.tablets.map((size) => size.name)).toEqual([
      "tablet-portrait",
    ]);
  });

  it("refuses a name that is no size, so a shard cannot walk nothing and pass", () => {
    expect(() => sizesToWalk("320,360")).toThrow(/no size called 360/);
  });
});
