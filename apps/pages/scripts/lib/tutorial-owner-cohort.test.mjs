import { expect, it } from "vitest";
import {
  OWNER_TUTORIALS,
  walkDefaultTutorialCohort,
} from "./tutorial-owner-cohort.mjs";

it("all and mixed requests preserve the default PIN cohort", () => {
  for (const ids of [
    [],
    ["vault.lock"],
    ["vault.lock", ...OWNER_TUTORIALS],
    ["unknown.goal"],
  ])
    expect(walkDefaultTutorialCohort(new Set(ids))).toBe(true);
});
it("explicit owner-only requests execute in their actual owner cohort", () => {
  for (const ids of [
    [OWNER_TUTORIALS[0]],
    [OWNER_TUTORIALS[1]],
    OWNER_TUTORIALS,
  ])
    expect(walkDefaultTutorialCohort(new Set(ids))).toBe(false);
});
