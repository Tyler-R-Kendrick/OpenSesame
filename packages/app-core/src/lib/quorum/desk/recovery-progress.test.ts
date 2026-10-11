import { describe, expect, it } from "vitest";
import { progressToward } from "./recovery-progress.js";

const group = (id: string, threshold: number, guardianIds: string[]) => ({
  id,
  threshold,
  guardianIds,
});

describe("how far a recovery has got against the rule", () => {
  const oneGroup = {
    groupThreshold: 1,
    groups: [group("all", 2, ["a", "b", "c"])],
  };

  it("counts contacts against the number the single group asks for", () => {
    expect(progressToward(oneGroup, [])).toEqual({
      have: 0,
      need: 2,
      unit: "contacts",
    });
    expect(progressToward(oneGroup, ["b"])).toEqual({
      have: 1,
      need: 2,
      unit: "contacts",
    });
  });

  it("never counts past what is asked for, and never counts a stranger", () => {
    expect(progressToward(oneGroup, ["a", "b", "c"]).have).toBe(2);
    expect(progressToward(oneGroup, ["zed"]).have).toBe(0);
    expect(progressToward(oneGroup, ["a", "a"]).have).toBe(1);
  });

  it("counts groups that have met their own threshold when there is more than one", () => {
    const twoLevel = {
      groupThreshold: 2,
      groups: [
        group("family", 2, ["a", "b", "c"]),
        group("friends", 1, ["d", "e"]),
        group("work", 2, ["f", "g"]),
      ],
    };
    // One member short of the family's threshold: no group yet.
    expect(progressToward(twoLevel, ["a", "f"])).toEqual({
      have: 0,
      need: 2,
      unit: "groups",
    });
    // Friends are met by one; the family is still short.
    expect(progressToward(twoLevel, ["a", "d"]).have).toBe(1);
    expect(progressToward(twoLevel, ["a", "b", "d"])).toEqual({
      have: 2,
      need: 2,
      unit: "groups",
    });
    expect(progressToward(twoLevel, ["a", "b", "d", "f", "g"]).have).toBe(2);
  });
});
